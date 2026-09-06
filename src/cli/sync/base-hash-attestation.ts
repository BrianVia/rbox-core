/**
 * Issue #816: the attested base hash.
 *
 * Every push reconstructs its delta base from persisted state and then proves
 * the base matches `manifestMeta.manifestHash` by canonically hashing all
 * 182k entries again (push.ts's `delta_base_ms` span, 1.3s on the desktop
 * fleet). The hash it recomputes is one this process ALREADY produced: the
 * previous push's target is this push's base, and the encoder stamped that
 * target's canonical hash as `resultHash` (manifest-delta.ts `encodeDeltaEnvelope`
 * / `encodeSnapshotEnvelope`), which `e2ee-remote.ts` writes straight into
 * `manifestMeta.manifestHash`.
 *
 * So record the proof instead of redoing it. The carrier is design 277's
 * loaded-state memo (state-plane/adapters/state-memo.ts): an accepted save is
 * retained under its post-write lineage token, and the next `loadState` returns
 * THAT SAME OBJECT iff nothing moved the store. Keying this attestation on that
 * object by identity therefore inherits, with nothing added, every invalidation
 * the memo already enforces — another writer's CAS bumps `state_revision`, a
 * reset replaces the lineage, a new process starts empty, `RBOX_STATE_LOAD_CACHE=0`
 * disables retention outright. Each of those is a miss, and a miss is the full
 * validate + hash exactly as before.
 *
 * ATTESTATION, NOT CACHE. The claim recorded is narrow and total:
 *   `canonicalManifestHashStreaming(manifestFromMeta(state.lastSyncedManifest,
 *    state.manifestMeta)) === manifestHash`, and that manifest is validateManifest-ok.
 * `attestSavedBase` refuses to record it unless the accepted state demonstrably
 * describes the manifest the encoder hashed (see its guards). A wrong skip
 * publishes a delta against a base no reader can reproduce, so every guard here
 * is fail-closed: any doubt records nothing.
 */
import type { Manifest } from "../../engine/index.js";
import type { GlobalManifestMeta, SyncState } from "../sync-state-model.js";

/** Every top-level member `manifestFromMeta` reconstructs. A manifest carrying
 *  anything else canonicalizes with a member the reconstruction cannot restore,
 *  so its persisted hash does NOT describe what the next push would rebuild —
 *  `validateManifest` admits such a manifest, and `fileOnlyManifest` and the
 *  state header both carry the member through, so nothing else catches it. */
const RECONSTRUCTED_MANIFEST_KEYS: ReadonlySet<string> = new Set(["generatedAt", "files", "manifestSchema", "gitRepos"]);

const reconstructible = (manifest: Manifest): boolean =>
  Object.keys(manifest).every((key) => RECONSTRUCTED_MANIFEST_KEYS.has(key));

interface AttestedBase {
  meta: GlobalManifestMeta;
  encManifestSha: string;
  manifestHash: string;
}

const ATTESTED = new WeakMap<Manifest, AttestedBase>();

/**
 * Record that `saved` — the state an accepted save returned — reconstructs to a
 * manifest whose canonical hash is `meta.manifestHash`.
 *
 * `meta` must be the meta of the commit receipt this save persisted, i.e. the
 * one carrying the encoder's `resultHash` for `committed`. The guards below are
 * all O(1) and each closes a way the accepted state can describe something else:
 *
 * - a `saveStateSource` recompute can drop `packet.global` (sync-state.ts's
 *   stale-global omission and the elision arm), leaving the OLDER meta and
 *   manifest in place — caught by the meta identity and sequence checks;
 * - the legacy-JSON fallback arm returns a state with no `manifestMeta` at all;
 * - a manifest carrying a PRESENT BUT EMPTY `gitRepos` canonicalizes with a
 *   `"gitRepos":{}` member that `manifestFromMeta` cannot restore (it omits the
 *   key when the meta's map is empty), so its reconstruction is NOT the hashed
 *   manifest — caught by the gitRepos presence check;
 * - a manifest carrying a top-level member outside the closed set
 *   `manifestFromMeta` rebuilds — `Manifest` is a TYPE, not a runtime shape, and
 *   `validateManifest` admits unknown members — is caught by `reconstructible`;
 * - a state whose file plane came back short is caught by the count check.
 */
export function attestSavedBase(
  saved: SyncState,
  committed: Manifest,
  meta: GlobalManifestMeta,
  acceptedSequence: number,
): void {
  const savedMeta = saved.manifestMeta;
  if (savedMeta === undefined) return;
  if (savedMeta.encManifestSha !== meta.encManifestSha || savedMeta.manifestHash !== meta.manifestHash) return;
  if (saved.lastSyncedSequence !== acceptedSequence) return;
  // `manifestFromMeta` restores gitRepos only when the meta's map is non-empty,
  // so those two facts must agree or the reconstruction differs from `committed`.
  if ((Object.keys(savedMeta.gitRepos).length > 0) !== (committed.gitRepos !== undefined)) return;
  const base = saved.lastSyncedManifest;
  if (!reconstructible(committed) || !reconstructible(base)) return;
  if (base.generatedAt !== committed.generatedAt) return;
  if (base.manifestSchema !== committed.manifestSchema) return;
  if (base.files.length !== committed.files.length) return;
  ATTESTED.set(base, { meta: savedMeta, encManifestSha: savedMeta.encManifestSha, manifestHash: savedMeta.manifestHash });
}

/** Does this state carry a standing attestation for exactly this meta? */
export function baseHashIsAttested(state: SyncState, meta: GlobalManifestMeta): boolean {
  const attested = ATTESTED.get(state.lastSyncedManifest);
  return attested !== undefined
    && attested.meta === state.manifestMeta
    && attested.encManifestSha === meta.encManifestSha
    && attested.manifestHash === meta.manifestHash;
}
