/** Resolve the absent/authoritative/damaged activation rule before catalog use. */
import { initializeFolderCatalog, initializeFolderCatalogAfterFirstBinding } from "./folder-catalog-generate.js";
import publishInternals, { inspectFolderCatalog } from "./folder-catalog-publish.js";
import { observeFolderGeneration } from "./folder-inventory.js";
import type { FolderCatalogState } from "./folder-config-codec.js";

export async function ensureFolderAuthority(
  context: { currentRoot?: string; admittedFirstBinding?: boolean } = {},
): Promise<Extract<FolderCatalogState, { kind: "authoritative" }>> {
  const state = await inspectFolderCatalog();
  if (state.kind === "authoritative") return state;
  if (state.kind === "damaged") throw publishInternals.authorityError(state);
  const inventory = await observeFolderGeneration(state, context);
  if (inventory.evidenceUnavailable?.length) {
    throw new Error(`cannot initialize rbox folder configuration because binding evidence is unavailable: ${inventory.evidenceUnavailable.join("; ")}`);
  }
  if (inventory.discoverableBindings.length > 0 || inventory.skipped.length > 0) {
    if (context.admittedFirstBinding && context.currentRoot) {
      await initializeFolderCatalogAfterFirstBinding(inventory, context.currentRoot);
      const initialized = await inspectFolderCatalog();
      if (initialized.kind === "authoritative") return initialized;
      throw publishInternals.authorityError(initialized);
    }
    throw publishInternals.authorityError(state);
  }
  await initializeFolderCatalog(inventory);
  const initialized = await inspectFolderCatalog();
  if (initialized.kind !== "authoritative") {
    if (initialized.kind === "damaged") throw publishInternals.authorityError(initialized);
    throw new Error("rbox folder configuration initialization did not publish a catalog");
  }
  return initialized;
}
