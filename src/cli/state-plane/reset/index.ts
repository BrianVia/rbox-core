import {
  hasDbArtifactResetCapability,
  sqliteResetFacade,
} from "./owner.js";

/**
 * The sole U3/production entry seam.  The token is captured by these closures
 * and cannot be obtained by importing either this facade or owner.ts.
 */
export { hasDbArtifactResetCapability, sqliteResetFacade };
export type { SqliteResetFacade } from "./owner.js";

export {
  classifySqliteResetPredecode,
  ResetOrphanArtifactHalt,
  type SqliteResetPredecodeRow,
} from "./classifier.js";
export type {
  ObservedSqliteResetJournal,
  SqliteResetHooks,
  SqliteResetInspection,
} from "./recovery.js";
