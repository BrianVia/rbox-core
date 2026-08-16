/**
 * File-level write readiness for the selected SQLite authority.
 *
 * A blocking migration control and a surviving genesis intent are the same
 * policy: authority recovery is not settled. This module owns that one
 * predicate without importing either protocol driver or opening SQLite.
 */
import { StateWriteRefusedError } from "./errors.js";
import { readGenesisIntent } from "./genesis-intent.js";
import { blocksSqliteWrites } from "./migration/control-codec.js";
import { readCanonicalControl } from "./migration/control-publication.js";
import { statePath } from "./paths.js";

export function assertAuthorityWritable(root: string): void {
  const control = readCanonicalControl(root);
  if (control && blocksSqliteWrites(control)) {
    refuse(root, `migration ${control.migrationId} is at ${control.witness.phase}`);
  }
  const intent = readGenesisIntent(root);
  if (intent) refuse(root, `genesis attempt ${intent.authorityId} has not been retired`);
}

function refuse(root: string, detail: string): never {
  throw new StateWriteRefusedError("authority-recovery-pending", statePath(root), detail);
}
