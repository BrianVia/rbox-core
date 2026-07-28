import { describe, expect, test } from "bun:test";
import {
  hasDbArtifactResetCapability,
  sqliteResetFacade,
} from "./index.js";
import * as ownerSurface from "./owner.js";
import { inspectSqliteReset } from "./recovery.js";

describe("DB-artifact reset capability", () => {
  test("is structurally derived from the complete lexical entry arena", () => {
    expect(hasDbArtifactResetCapability()).toBe(true);
    expect(Object.isFrozen(sqliteResetFacade)).toBe(true);
    expect(Object.keys(sqliteResetFacade).sort()).toEqual([
      "begin", "inspect", "kind", "observeControlPlane", "observeJournal", "recover",
    ]);
  });

  test("exports no token/key and raw executors reject structural forgeries", async () => {
    expect(Object.keys(ownerSurface).sort()).toEqual([
      "assertDbArtifactResetExecutorCapability",
      "hasDbArtifactResetCapability",
      "sqliteResetFacade",
    ]);
    await expect(inspectSqliteReset(
      { kind: "db-artifact-reset-executor/v1" } as never,
      "/not-observed",
    )).rejects.toThrow("requires its confined capability");
  });
});
