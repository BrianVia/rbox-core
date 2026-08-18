/** Never: generic lock ownership, journal I/O, recovery policy, or non-CAS lockfile defaults. */
import path from "node:path";
import { fsyncDirectory } from "../../engine/fsutil.js";

type SyncDirectory = (directory: string) => Promise<void>;

interface Publication {
  finalizeDurable: () => Promise<void>;
}

/** One acquisition's exact namespace-durability owner. Outcomes and parents
 * flush together, so a locked journal phase cannot omit either. */
export class StateCasAcquisitionBatch {
  readonly #expected: Set<string>;
  readonly #publications = new Map<string, Publication>();
  readonly #outcomes = new Map<string, "acquired" | "blocked">();
  readonly #syncDirectory: SyncDirectory;
  #used = false;
  #flushed = false;

  constructor(expectedPaths: readonly string[], syncDirectory: SyncDirectory = fsyncDirectory) {
    this.#expected = new Set(expectedPaths);
    if (this.#expected.size !== expectedPaths.length) throw new Error("duplicate state-CAS batch path");
    this.#syncDirectory = syncDirectory;
  }

  deferPublication(
    lockPath: string,
    finalizeDurable: () => Promise<void>,
  ): void {
    this.#assertOpenPath(lockPath);
    if (this.#publications.has(lockPath)) throw new Error("duplicate state-CAS publication");
    this.#publications.set(lockPath, { finalizeDurable });
  }

  record(lockPath: string, outcome: "acquired" | "blocked"): void {
    this.#assertOpenPath(lockPath);
    if (this.#outcomes.has(lockPath)) throw new Error("duplicate state-CAS acquisition outcome");
    if ((outcome === "acquired") !== this.#publications.has(lockPath)) {
      throw new Error("state-CAS outcome does not match publication");
    }
    this.#outcomes.set(lockPath, outcome);
  }

  async flushAll(): Promise<void> {
    if (this.#used) throw new Error("state-CAS acquisition batch already used");
    this.#used = true;
    if (this.#outcomes.size !== this.#expected.size) throw new Error("state-CAS acquisition batch is incomplete");
    const parents = new Set([...this.#publications.keys()].map((lockPath) => path.dirname(lockPath)));
    let flushError: unknown;
    for (const parent of [...parents].sort()) {
      try { await this.#syncDirectory(parent); }
      catch (error) { flushError ??= error; }
    }
    if (flushError) throw flushError;
    for (const publication of this.#publications.values()) await publication.finalizeDurable();
    this.#flushed = true;
  }

  assertFlushed(): void {
    if (!this.#flushed) throw new Error("state-CAS acquisition batch is not flushed");
  }

  #assertOpenPath(lockPath: string): void {
    if (this.#used) throw new Error("state-CAS acquisition batch already used");
    if (!this.#expected.has(lockPath)) throw new Error(`state-CAS batch path is not allowlisted: ${lockPath}`);
  }
}

/** Release batching retains a per-parent result rather than promoting a
 * partial flush into transaction-wide durability. */
export class StateCasReleaseBatch {
  readonly #paths = new Set<string>();
  readonly #syncDirectory: SyncDirectory;
  #durableParents: Set<string> | undefined;

  constructor(syncDirectory: SyncDirectory = fsyncDirectory) {
    this.#syncDirectory = syncDirectory;
  }

  deferRelease(lockPath: string): void {
    if (this.#durableParents) throw new Error("state-CAS release batch already used");
    this.#paths.add(lockPath);
  }

  async flushAll(): Promise<void> {
    if (this.#durableParents) throw new Error("state-CAS release batch already used");
    const durable = new Set<string>();
    this.#durableParents = durable;
    const parents = new Set([...this.#paths].map((lockPath) => path.dirname(lockPath)));
    for (const parent of [...parents].sort()) {
      try {
        await this.#syncDirectory(parent);
        durable.add(parent);
      } catch { /* each lock maps only its actual parent's success */ }
    }
  }

  durable(lockPath: string): boolean {
    if (!this.#durableParents) throw new Error("state-CAS release batch is not flushed");
    return this.#paths.has(lockPath) && this.#durableParents.has(path.dirname(lockPath));
  }
}
