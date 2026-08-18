/** Never: runtime behavior or capability construction. */
import {
  sqliteResetFacade,
  type SqliteResetFacade,
} from "./index.js";
import { inspectSqliteReset } from "./recovery.js";
import type { DbArtifactResetExecutorCapability } from "./owner.js";

declare function u3ShapedEntry(facade: SqliteResetFacade): void;

// These are compile-time fixtures, not runtime assertions. If the brand ever
// becomes structurally forgeable, either @ts-expect-error becomes unused and
// the repository typecheck fails.
// @ts-expect-error a lookalike lacks the module-private brand
const forged: SqliteResetFacade = { kind: "db-artifact-reset/v1" };
if (false) {
  // @ts-expect-error a partial entry facade cannot satisfy the complete seam
  u3ShapedEntry({ kind: "db-artifact-reset/v1" });
  // @ts-expect-error raw executors cannot be invoked without the lexical token
  void inspectSqliteReset("/not-observed", "old");
  // @ts-expect-error the module-private brand prevents token construction
  const token: DbArtifactResetExecutorCapability = {
    kind: "db-artifact-reset-executor/v1",
  };
  void token;
}

u3ShapedEntry(sqliteResetFacade);
void forged;
