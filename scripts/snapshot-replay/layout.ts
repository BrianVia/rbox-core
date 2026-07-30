/**
 * The sandbox layout and the two audit rule sets, in one place.
 *
 * The harness never migrates a real workspace: it copies one into a sandbox and
 * drives the 2.0 machine against the COPY. Two child processes do the work, and
 * each is straced with a different rule about what it is allowed to touch:
 *
 * - the SNAPSHOT child may READ the real workspace and may write only the
 *   sandbox;
 * - the REPLAY child may not name the real workspace's state plane at all, and
 *   may write only the sandbox.
 *
 * Both rules are enforced after the fact against the strace log rather than
 * asserted, because the point of the harness is evidence.
 */
import path from "node:path";

export interface SandboxLayout {
  readonly root: string;
  /** The replay workspace root: `.rbox` plus the repository stubs. */
  readonly ws: string;
  /** `HOME` and `RBOX_HOME` for the replay child. */
  readonly home: string;
  /** The byte-identical legacy document the fidelity check reads after M6
   * deletes the live one. */
  readonly pristineState: string;
  /** Where the first of the two stability copies lands. */
  readonly stage: string;
  /** strace logs, child reports, and the final report. */
  readonly probe: string;
}

export function sandboxLayout(root: string): SandboxLayout {
  return {
    root,
    ws: path.join(root, "ws"),
    home: path.join(root, "home"),
    pristineState: path.join(root, "pristine", "state.json"),
    stage: path.join(root, "stage-a"),
    probe: path.join(root, "probe"),
  };
}

/** Subtrees of `.rbox` the state plane never reads, excluded so the stability
 * check is not fighting the live daemon's caches for no fidelity gain. Every
 * exclusion is reported. */
export const SNAPSHOT_EXCLUDES = ["trash", "gitcap", "state/uploads", "state/tmp"] as const;

export interface SnapshotReport {
  readonly source: string;
  readonly sandbox: string;
  readonly copyAttempts: number;
  readonly excluded: readonly string[];
  readonly bytes: number;
  readonly files: number;
  readonly stateJsonBytes: number;
  readonly repoStubs: number;
  /** Repos whose real `.git` is a pointer file. Reproduced as a plain directory
   * stub on purpose: a faithful pointer would aim the fence's locks at the REAL
   * repository outside the sandbox. */
  readonly pointerRepos: readonly string[];
  readonly fixups: readonly string[];
  readonly elapsedMs: number;
}
