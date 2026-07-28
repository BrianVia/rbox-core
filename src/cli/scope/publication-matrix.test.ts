/**
 * Design 212 acceptance 2 — the seal. On a scoped binding every publication
 * entrance must produce ZERO git-plan / upload / commit calls, each with its own
 * named refusal, and `recover` must refuse before it reads or writes anything.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pushManifest } from "../sync/push.js";
import { recoverWorkspaceCmd } from "../recover-cmd.js";
import type { WorkspaceConfig } from "../workspace-config.js";
import { ScopedBindingRefusal } from "./binding-scope.js";

let home: string;
let root: string;
const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-seal-home-"));
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-seal-root-"));
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

const cfg = (scope?: string[]): WorkspaceConfig => ({
  remoteWorkspaceId: "ws_seal",
  projectId: "root",
  deviceId: "dev_1",
  rootPath: root,
  remoteUrl: "https://api.test",
  token: "",
  ...(scope ? { scope } : {}),
});

async function bind(scope?: string[]): Promise<void> {
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify(cfg(scope)));
}

/** Any remote touch at all is a failure: the chokepoint sits ahead of receipt
 *  reconciliation, the scan, git planning, upload, and repair. */
function tripwireRemote(): { remote: unknown; touched: string[] } {
  const touched: string[] = [];
  const remote = new Proxy({}, {
    get(_target, prop) {
      touched.push(String(prop));
      return () => { throw new Error(`remote.${String(prop)} must not be reached on a scoped binding`); };
    },
  });
  return { remote, touched };
}

test("pushManifest refuses a scoped binding before touching the remote", async () => {
  await bind(["Personal/repo-A"]);
  const { remote, touched } = tripwireRemote();
  const attempt = pushManifest(root, cfg(["Personal/repo-A"]), { generatedAt: "", files: [] },
    { remote: remote as never });
  await expect(attempt).rejects.toThrow(ScopedBindingRefusal);
  expect(touched).toEqual([]);
});

test("the refusal carries the named condition, not just prose", async () => {
  await bind(["Personal/repo-A"]);
  try {
    await pushManifest(root, cfg(["Personal/repo-A"]), { generatedAt: "", files: [] });
    throw new Error("expected a refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(ScopedBindingRefusal);
    expect((error as ScopedBindingRefusal).condition).toBe("scoped-binding-cannot-publish");
  }
});

test("a halted binding refuses publication too, without demoting to unscoped", async () => {
  await bind();
  await fs.mkdir(path.join(home, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(home, ".rbox", "workspaces.json"), JSON.stringify({
    schemaVersion: 1,
    entries: [{ root, workspaceId: "ws_seal", boundAt: "x", lastSeenAt: "x", scope: ["Personal/repo-A"] }],
  }));
  const { remote, touched } = tripwireRemote();
  await expect(pushManifest(root, cfg(), { generatedAt: "", files: [] }, { remote: remote as never }))
    .rejects.toMatchObject({ condition: "scope-witness-disagreement" });
  expect(touched).toEqual([]);
});

test("an unscoped binding is unaffected: the seal never stands in its way", async () => {
  await bind();
  const { remote } = tripwireRemote();
  // Byte-for-byte regression control (acceptance 11): the ordinary publication
  // pipeline runs and completes, and no scope refusal is raised anywhere in it.
  const result = await pushManifest(root, cfg(), { generatedAt: "", files: [] }, { remote: remote as never });
  expect(result.committed).toBe(false);
});

test("recover refuses upfront: zero manifest reads, zero writes, zero prompts", async () => {
  await bind(["Personal/repo-A"]);
  const calls: string[] = [];
  const attempt = recoverWorkspaceCmd(root, { yes: true }, {
    confirm: async () => { calls.push("confirm"); return true; },
    loadCredentials: async () => { calls.push("loadCredentials"); throw new Error("unreached"); },
    pull: (async () => { calls.push("pull"); }) as never,
    push: (async () => { calls.push("push"); }) as never,
    repair: (async () => { calls.push("repair"); }) as never,
    log: () => {},
  });
  await expect(attempt).rejects.toBeInstanceOf(ScopedBindingRefusal);
  expect(calls).toEqual([]);
});
