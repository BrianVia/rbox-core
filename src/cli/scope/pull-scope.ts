/**
 * The scope-shaped inputs one pull needs, resolved in a single place before the
 * pull reconciles, fetches, or applies anything (design 212 §3.2).
 *
 * Everything here is a no-op on an unscoped binding: the same manifests come back
 * out, so the pull's own code reads identically either way.
 */
import type { Action, Manifest } from "../../engine/index.js";
import type { SyncState } from "../sync-state-model.js";
import { assertBindingUsable, resolveBindingScope } from "./binding-scope.js";
import { composeScopedBase, ScopeProjection } from "./projection.js";
import { applyRuleFileAuthority, type RuleFileAuthorityOutcome } from "./rule-authority.js";

export interface ScopedPull {
  /** Absent on an unscoped binding. */
  projection?: ScopeProjection;
  /** What reconcile compares, and what the mass-delete guard counts against. */
  reconcileBase: Manifest;
  local: Manifest;
  remote: Manifest;
  /** The manifest to persist as the new base. */
  storedBase: Manifest;
  /** Whether `storedBase` still describes the remote commit exactly; when it does
   *  not, the delta fold metadata must not be persisted beside it. */
  storedBaseIsRemote: boolean;
  /** Restrict git repo keys to the ones this binding may probe. */
  probeKeys: (keys: string[]) => string[];
}

/**
 * Classify the remote git topology and project every manifest, BEFORE file
 * reconcile. Discovering a boundary-crossing repository later, during git apply,
 * would already be too late: its working files would have moved while its history
 * stayed behind.
 */
export async function prepareScopedPull(root: string, state: SyncState, local: Manifest, remote: Manifest): Promise<ScopedPull> {
  const seal = await resolveBindingScope(root);
  assertBindingUsable(seal);
  if (seal.kind !== "scoped") {
    return {
      reconcileBase: state.lastSyncedManifest,
      local,
      remote,
      storedBase: remote,
      storedBaseIsRemote: true,
      probeKeys: (keys) => keys,
    };
  }
  const projection = new ScopeProjection(seal.prefixes, [
    ...Object.keys(remote.gitRepos ?? {}),
    ...Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
    ...Object.keys(state.gitPendingRemote ?? {}),
  ]);
  const storedBase = composeScopedBase(state.lastSyncedManifest, remote, projection);
  return {
    projection,
    reconcileBase: projection.projectFiles(state.lastSyncedManifest),
    local: projection.projectFiles(local),
    remote: projection.projectFiles(remote),
    storedBase,
    storedBaseIsRemote: storedBase === remote,
    probeKeys: (keys) => projection.probeKeys(keys),
  };
}

/**
 * Remote is authoritative for the ignore-rule files a scoped binding carries as
 * metadata. Returns the amended actions and the rule files whose local bytes lost.
 */
export function applyScopedRuleAuthority(
  actions: Action[],
  scoped: ScopedPull,
  device: string,
  now: string,
): RuleFileAuthorityOutcome {
  if (!scoped.projection) return { actions, diverged: [] };
  return applyRuleFileAuthority(actions, scoped.projection, scoped.reconcileBase, scoped.local, scoped.remote, device, now);
}
