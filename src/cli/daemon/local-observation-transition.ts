/** Never: observing disk, scheduling scans, or interpreting push/pull outcomes. */
import type { Manifest } from "../../engine/index.js";
import { omitPaths, type ManifestUpdate } from "./manifest-update.js";

/**
 * `CommitLocalObservation` — the ONE owner of LOCAL authority: the manifest this
 * daemon believes is on disk, how much of that belief was actually observed, which
 * paths nobody could read, and the provenance trusted-pull P2/P5/P7 reads.
 *
 * Every advance is a named transition bound to an exact identity
 * (`{observationId, lineageToken, priorLocalRevision, logicalDigest}`) sealed by the
 * observation that produced it. A mismatched, replayed, or superseded identity
 * performs NO transition — LOCAL and deletion authority fail closed rather than
 * accept a receipt whose plan no longer describes this lineage.
 *
 * Three writers, no fourth:
 *   - {@link LocalAuthority.seed} — the durable BASE arrives; nothing is observed yet;
 *   - {@link LocalAuthority.commitObservation} — a sealed observation receipt;
 *   - {@link LocalAuthority.commitPatch} — a bounded patch that made no observation
 *     of its own (a committed push subset, a pull's O(applied) refresh).
 */

/** The LOCAL lineage an observation was planned against. Captured at observation
 *  START — the same synchronous moment design 206 §2 captures the matcher generation. */
export interface LineageSnapshot {
  readonly lineageToken: string;
  readonly localRevision: number;
}

export interface LocalObservationIdentity {
  readonly observationId: string;
  readonly lineageToken: string;
  readonly priorLocalRevision: number;
  readonly logicalDigest: string;
}

export interface UnsettledDirective {
  /** A full-workspace observation re-derives the whole set from its own cursor. */
  readonly rebuildFrom?: ReadonlySet<string>;
  readonly settle?: Iterable<string>;
  readonly add?: Iterable<string>;
}

export interface LocalObservationCommitIntent {
  readonly identity: LocalObservationIdentity;
  readonly next: Manifest;
  readonly update: ManifestUpdate;
  readonly unsettled: UnsettledDirective;
  /** Design 206 §2: the generation the OBSERVATION started under. Meaningless for a
   *  bounded patch (it observed nothing) and for the seed (nothing observed at all). */
  readonly observedUnderMatcherGeneration?: number;
  /** Absent means this commit makes NO completeness claim: only a full-workspace
   *  observation may testify that the whole file set was read. */
  readonly completeness?: "complete" | "deferred";
}

export type LocalObservationCommitOutcome = "advanced" | "replayed" | "identity-mismatch" | "stale-revision";

export interface LocalObservationCommitReceipt {
  readonly observationId: string;
  readonly outcome: LocalObservationCommitOutcome;
  /** The revision AFTER this transition — unchanged when it performed no write. */
  readonly localRevision: number;
  readonly observationComplete: boolean;
}

/** The commit half of the seam, as the observation executor sees it. */
export interface LocalAuthorityPort {
  snapshot(): LineageSnapshot;
  commitObservation(intent: LocalObservationCommitIntent): LocalObservationCommitReceipt;
  readonly observationComplete: boolean;
}

/**
 * The digest binds the clauses a consumer of LOCAL acts on — provenance kind, the
 * completeness claim, the observed matcher generation, the size of what was touched,
 * and the head's own identity — NOT the file contents: a content hash would make
 * every bounded patch O(workspace) and undo design 202's whole point.
 */
export function sealLocalObservationIdentity(
  observationId: string,
  snapshot: LineageSnapshot,
  payload: Omit<LocalObservationCommitIntent, "identity">,
): LocalObservationIdentity {
  const { update } = payload;
  const scope = update.kind === "full-workspace" ? `${update.coverage}:${update.deferred.size}` : `${update.source}:${update.paths.size}`;
  return {
    observationId,
    lineageToken: snapshot.lineageToken,
    priorLocalRevision: snapshot.localRevision,
    logicalDigest: [
      update.kind, scope,
      payload.next.files.length, payload.next.generatedAt,
      payload.observedUnderMatcherGeneration ?? -1,
      payload.completeness ?? "-",
      payload.unsettled.rebuildFrom?.size ?? -1,
    ].join("|"),
  };
}

/** Enough to recognize a replayed receipt in the window where a replay can happen;
 *  a superseded revision refuses anything older regardless. */
const REPLAY_MEMORY = 64;

export class LocalAuthority implements LocalAuthorityPort {
  private head: Manifest = { generatedAt: "", files: [] };
  /** After a collision push the head is the safe publication subset, not a complete
   *  observation of the skipped disk paths. Only a fresh scan restores completeness. */
  private complete = true;
  /** Design 202: paths whose on-disk truth this daemon has NOT observed — watcher
   *  deferrals, scan deferrals, write-finish give-ups, and conflict copies a pull just
   *  created. Stripped from any trusted local view (restoring pull's scan-omission
   *  semantics, design 108) and exempt from the git oracle. */
  private readonly unsettled = new Set<string>();
  private update?: ManifestUpdate;
  /** P5: has any full-workspace commit landed since the last seed? */
  private fullWorkspace = false;
  /** P7: the generation the CURRENT head's full-workspace observation STARTED under. */
  private observedGeneration = -1;
  private revision = 0;
  private lineageSeq = 0;
  private lineage = "lineage-0";
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];

  get manifest(): Manifest { return this.head; }
  get observationComplete(): boolean { return this.complete; }
  get unsettledPaths(): ReadonlySet<string> { return this.unsettled; }
  get lastUpdate(): ManifestUpdate | undefined { return this.update; }
  get fullWorkspaceSinceSeed(): boolean { return this.fullWorkspace; }
  /** How many observation ids the replay memory currently holds. Bounded by
   *  REPLAY_MEMORY — a daemon that ran for weeks must not accumulate one per
   *  observation. Observability only; nothing may branch on it. */
  get replayMemorySize(): number { return this.seen.size; }
  get observedMatcherGeneration(): number { return this.observedGeneration; }

  snapshot(): LineageSnapshot {
    return { lineageToken: this.lineage, localRevision: this.revision };
  }

  /** "This head minus the paths nobody can currently observe" — the only shape LOCAL
   *  may cross a seam in, so an unread path can never be planned as a deletion. */
  trustedProjection(): Manifest {
    return omitPaths(this.head, this.unsettled);
  }

  /** The durable BASE arrives: a NEW lineage, no observation behind it, so provenance
   *  is cleared rather than stamped and P5 goes false until a scan commits. */
  seed(manifest: Manifest): void {
    this.lineage = `lineage-${++this.lineageSeq}`;
    this.unsettled.clear();
    this.install(manifest, undefined, undefined);
  }

  commitObservation(intent: LocalObservationCommitIntent): LocalObservationCommitReceipt {
    const refuse = (outcome: LocalObservationCommitOutcome): LocalObservationCommitReceipt =>
      ({ observationId: intent.identity.observationId, outcome, localRevision: this.revision, observationComplete: this.complete });
    const { identity } = intent;
    if (identity.lineageToken !== this.lineage) return refuse("identity-mismatch");
    if (this.seen.has(identity.observationId)) return refuse("replayed");
    if (identity.priorLocalRevision !== this.revision) return refuse("stale-revision");
    if (identity.logicalDigest !== sealLocalObservationIdentity(identity.observationId, this.snapshot(), intent).logicalDigest) {
      return refuse("identity-mismatch");
    }
    this.remember(identity.observationId);
    if (intent.completeness !== undefined) this.complete = intent.completeness === "complete";
    this.reconcileUnsettled(intent.unsettled);
    this.install(intent.next, intent.update, intent.observedUnderMatcherGeneration);
    return { observationId: identity.observationId, outcome: "advanced", localRevision: this.revision, observationComplete: this.complete };
  }

  /** A bounded update that observed nothing of its own: it may move the head at the
   *  paths it names and reconcile them, but it can neither upgrade P5 nor re-stamp P7
   *  nor testify to completeness. */
  commitPatch(next: Manifest, update: ManifestUpdate & { kind: "partial" }, unsettled: UnsettledDirective): void {
    this.reconcileUnsettled(unsettled);
    this.install(next, update, undefined);
  }

  /** A path that exhausted its read budget stays UNOBSERVED until the next scan. It
   *  withholds trust from that path without moving the head, so it does not advance
   *  the revision an in-flight observation was planned against. */
  markUnsettled(relPath: string): void {
    this.unsettled.add(relPath);
  }

  /** The unconditional downgrade: a failure-capable publication path or an observed
   *  collision withdraws completeness immediately. Only a commit may restore it. */
  setObservationComplete(complete: boolean): void {
    this.complete = complete;
  }

  /** Applied in the order a caller means it: `rebuildFrom` first (a full-workspace
   *  observation re-derives the whole set), then `settle` (paths this update read
   *  cleanly), then `add` (paths it could not read) — so a path that is both
   *  re-observed and re-deferred ends up unsettled. */
  private reconcileUnsettled(unsettled: UnsettledDirective): void {
    if (unsettled.rebuildFrom) {
      this.unsettled.clear();
      for (const p of unsettled.rebuildFrom) this.unsettled.add(p);
    }
    if (unsettled.settle) for (const p of unsettled.settle) this.unsettled.delete(p);
    if (unsettled.add) for (const p of unsettled.add) this.unsettled.add(p);
  }

  private install(next: Manifest, update: ManifestUpdate | undefined, observedUnder: number | undefined): void {
    this.head = next;
    this.update = update;
    this.revision += 1;
    if (update === undefined) {
      this.fullWorkspace = false;
      this.observedGeneration = -1;
    } else if (update.kind === "full-workspace") {
      this.fullWorkspace = true;
      this.observedGeneration = observedUnder ?? -1;
    }
  }

  private remember(observationId: string): void {
    this.seen.add(observationId);
    this.seenOrder.push(observationId);
    if (this.seenOrder.length > REPLAY_MEMORY) this.seen.delete(this.seenOrder.shift()!);
  }
}
