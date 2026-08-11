import { saveConfig, type WorkspaceConfig } from "../config.js";
import {
  initializeFolderCatalog,
  inspectFolderCatalog,
  recordFolder,
  snapshotPreCatalogPolicy,
} from "../folder-config.js";

/** Give direct daemon unit tests the binding/catalog pair that production gets
 * from the admitted startup factory. This exercises the real boundary rather
 * than installing a runtime bypass. */
export async function prepareDaemonFolderAdmission(root: string, cfg: WorkspaceConfig): Promise<void> {
  let state = await inspectFolderCatalog();
  if (state.kind === "damaged") throw new Error(state.reason);
  if (state.kind === "absent") {
    try {
      await initializeFolderCatalog({
        revision: state.revision,
        discoverableBindings: [],
        skipped: [],
      });
    } catch (error) {
      state = await inspectFolderCatalog();
      if (state.kind !== "authoritative") throw error;
    }
  }
  await saveConfig(root, cfg);
  await recordFolder(root, { options: snapshotPreCatalogPolicy(cfg) });
}
