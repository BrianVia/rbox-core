import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertBindingUsable,
  assertCommandAllowedOnScopedBinding,
  assertMayPublish,
  resolveBindingScope,
  ScopedBindingRefusal,
} from "./binding-scope.js";

let home: string;
let root: string;
const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;
const WORKSPACE_ID = "ws_scope";

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-scope-home-"));
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-scope-root-"));
  process.env.RBOX_HOME = home;
  process.env.HOME = home;
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
});

afterEach(async () => {
  if (originalRboxHome === undefined) delete process.env.RBOX_HOME; else process.env.RBOX_HOME = originalRboxHome;
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
});

async function writeRecord(fields: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({
    remoteWorkspaceId: WORKSPACE_ID,
    projectId: "root",
    remoteUrl: "https://api.test",
    deviceId: "dev_1",
    rootPath: root,
    token: "",
    ...fields,
  }));
}

async function writeWitness(scope: string[] | undefined, workspaceId = WORKSPACE_ID): Promise<void> {
  await fs.mkdir(path.join(home, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(home, ".rbox", "workspaces.json"), JSON.stringify({
    schemaVersion: 1,
    entries: [{
      root, workspaceId, boundAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:00:00Z",
      ...(scope ? { scope } : {}),
    }],
  }));
}

test("a legacy unscoped binding stays unscoped and may publish", async () => {
  await writeRecord({});
  await writeWitness(undefined);
  expect(await resolveBindingScope(root)).toEqual({ kind: "unscoped" });
  await assertMayPublish(root);
});

test("no binding record and no scope evidence is not this seal's problem", async () => {
  expect(await resolveBindingScope(root)).toEqual({ kind: "unscoped" });
});

test("a scoped record with a matching witness is scoped, and refuses publication", async () => {
  await writeRecord({ scope: ["Personal/repo-A"], scopeGeneration: 3 });
  await writeWitness(["Personal/repo-A"]);
  expect(await resolveBindingScope(root)).toEqual({ kind: "scoped", prefixes: ["Personal/repo-A"], generation: 3 });
  await expect(assertMayPublish(root)).rejects.toThrow(/never send them/);
  try {
    await assertMayPublish(root);
  } catch (error) {
    expect((error as ScopedBindingRefusal).condition).toBe("scoped-binding-cannot-publish");
  }
});

test("witness loss cannot demote a scoped binding — the record is canonical", async () => {
  await writeRecord({ scope: ["Personal/repo-A"] });
  const seal = await resolveBindingScope(root);
  expect(seal.kind).toBe("scoped");
});

test("a record that lost its scope while the witness still names it HALTS", async () => {
  await writeRecord({});
  await writeWitness(["Personal/repo-A"]);
  const seal = await resolveBindingScope(root);
  expect(seal).toMatchObject({ kind: "halted", condition: "scope-witness-disagreement" });
  await expect(assertMayPublish(root)).rejects.toThrow(/paused/);
});

test("a missing binding record with scope evidence HALTS rather than reading as unscoped", async () => {
  await writeWitness(["Personal/repo-A"]);
  expect(await resolveBindingScope(root)).toMatchObject({ kind: "halted", condition: "binding-record-unreadable" });
});

test("a corrupt scope field is present-but-broken, never absent", async () => {
  await writeRecord({ scope: ["../escape"] });
  expect(await resolveBindingScope(root)).toMatchObject({ kind: "halted", condition: "binding-record-unreadable" });
  await writeRecord({ scope: [] });
  expect(await resolveBindingScope(root)).toMatchObject({ kind: "halted", condition: "binding-record-unreadable" });
});

test("witnesses that name DIFFERENT folders disagree", async () => {
  await writeRecord({ scope: ["Personal/repo-A"] });
  await writeWitness(["Work/repo-B"]);
  expect(await resolveBindingScope(root)).toMatchObject({ kind: "halted", condition: "scope-witness-disagreement" });
});

test("a witness row from a PREVIOUS binding incarnation cannot halt a rebound root", async () => {
  await writeRecord({});
  await writeWitness(["Personal/repo-A"], "ws_previous");
  expect(await resolveBindingScope(root)).toEqual({ kind: "unscoped" });
});

test("a halted binding refuses reads too, not just publication", async () => {
  await writeWitness(["Personal/repo-A"]);
  const seal = await resolveBindingScope(root);
  expect(() => assertBindingUsable(seal)).toThrow(ScopedBindingRefusal);
});

test("command admission names the remedy per verb", async () => {
  await writeRecord({ scope: ["Personal/repo-A"] });
  await expect(assertCommandAllowedOnScopedBinding(root, "recover")).rejects.toThrow(/rbox recover.*whole workspace/s);
  await expect(assertCommandAllowedOnScopedBinding(root, "purge")).rejects.toThrow(/ignore rules/);
  await expect(assertCommandAllowedOnScopedBinding(root, "push")).rejects.toThrow(/only receives/);
});

test("command admission is a no-op on an unscoped binding", async () => {
  await writeRecord({});
  await assertCommandAllowedOnScopedBinding(root, "push");
});
