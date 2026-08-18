/**
 * File-level write readiness for the selected SQLite authority.
 *
 * Refuse SQLite writes while a surviving genesis intent is unsettled.
 */
import { StateWriteRefusedError } from "./errors.js";
import { readGenesisIntent } from "./genesis-intent.js";
import { statePath } from "./paths.js";

export function assertAuthorityWritable(root: string): void {
  const intent = readGenesisIntent(root);
  if (intent) refuse(root, `genesis attempt ${intent.authorityId} has not been retired`);
}

function refuse(root: string, detail: string): never {
  throw new StateWriteRefusedError("authority-recovery-pending", statePath(root), detail);
}
