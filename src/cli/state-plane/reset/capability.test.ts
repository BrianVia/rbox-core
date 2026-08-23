import { describe, expect, test } from "bun:test";
import {
  hasDbArtifactResetCapability,
  sqliteResetFacade,
} from "./index.js";
import * as ownerSurface from "./owner.js";
import {
  beginSqliteReset,
  inspectSqliteReset,
  observeSqliteResetControlPlane,
  recoverSqliteReset,
} from "./recovery.js";

describe("DB-artifact reset capability", () => {

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

  test("raw begin rejects a structural capability forgery", async () => {
    await expect(beginSqliteReset(
      { kind: "db-artifact-reset-executor/v1" } as never,
      "/not-observed", "next", { stream: "old", stateNonce: "1".repeat(32) }, [],
      { version: 2, authorizedNextStream: "next", consentKind: "setup-rebind", mintedAtRevision: 0 },
      {} as never,
    )).rejects.toThrow("requires its confined capability");
  });

  test("raw recovery rejects a structural capability forgery", async () => {
    await expect(recoverSqliteReset(
      { kind: "db-artifact-reset-executor/v1" } as never,
      "/not-observed", "old", {} as never,
    )).rejects.toThrow("requires its confined capability");
  });

  test("raw control observation rejects a structural capability forgery", async () => {
    await expect(observeSqliteResetControlPlane(
      { kind: "db-artifact-reset-executor/v1" } as never,
      "/not-observed", {} as never,
    )).rejects.toThrow("requires its confined capability");
  });
});
