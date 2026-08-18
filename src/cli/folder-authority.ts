/** Resolve the absent/authoritative/damaged activation rule before catalog use.
 *
 * Never: mutation commands, generation discovery internals, policy resolution, runtime admission,
 * or daemon transitions.
 */
import { initializeFolderCatalog } from "./folder-catalog-generate.js";
import publishInternals, { inspectFolderCatalog } from "./folder-catalog-publish.js";
import { observeFolderGeneration } from "./folder-inventory.js";
import type { FolderCatalogState } from "./folder-config-codec.js";

export async function ensureFolderAuthority(
  context: { currentRoot?: string } = {},
): Promise<Extract<FolderCatalogState, { kind: "authoritative" }>> {
  const state = await inspectFolderCatalog();
  if (state.kind === "authoritative") return state;
  if (state.kind === "damaged") throw publishInternals.authorityError(state);
  const inventory = await observeFolderGeneration(state, context);
  if (inventory.evidenceUnavailable?.length) {
    throw new Error(`cannot initialize rbox folder configuration because binding evidence is unavailable: ${inventory.evidenceUnavailable.join("; ")}`);
  }
  // An absent catalog has nothing to lose by construction: generation reproduces
  // every discoverable binding with its own pre-catalog policy. A skipped row is
  // the one thing generation would silently drop, so it still refuses toward
  // `rbox config regenerate` (design 276 F1.3).
  if (inventory.skipped.length > 0) throw publishInternals.authorityError(state);
  await initializeFolderCatalog(inventory);
  const initialized = await inspectFolderCatalog();
  if (initialized.kind !== "authoritative") {
    if (initialized.kind === "damaged") throw publishInternals.authorityError(initialized);
    throw new Error("rbox folder configuration initialization did not publish a catalog");
  }
  return initialized;
}
