/** Runtime admission for command-level daemon starts (design 231 §7.3).
 *
 * Never: desired-state mutation, process spawning, daemon policy application, or catalog mutation.
 */
import { ensureFolderAuthority } from "../folder-authority.js";
import { observeFolderAdmission, runtimeRefusal, type FolderAdmission } from "../folder-inventory.js";

export async function requireFolderAdmission(root: string): Promise<Extract<FolderAdmission, { kind: "admitted" }>> {
  const state = await ensureFolderAuthority({ currentRoot: root });
  const admission = await observeFolderAdmission(root, state);
  if (admission.kind !== "admitted") throw runtimeRefusal(admission);
  return admission;
}
