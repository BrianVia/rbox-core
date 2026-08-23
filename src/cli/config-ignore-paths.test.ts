import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanManifest } from "../engine/index.js";
import { inspectFolderCatalog, serializeFolderCatalog } from "./folder-config.js";
import { applyFolderPolicy, observeFolderAdmission } from "./folder-inventory.js";
import { folderCatalogPath } from "./rbox-paths.js";
import { matcherForState } from "./sync/policy.js";
import type { WorkspaceConfig } from "./workspace-config.js";

const originalRboxHome = process.env.RBOX_HOME;
let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-config-ignore-paths-"));
  process.env.RBOX_HOME = path.join(scratch, "home");
});

afterEach(async () => {
  if (originalRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = originalRboxHome;
  await fs.rm(scratch, { recursive: true, force: true });
});

test("folder policy overlays machine-local ignores onto sync but not purge safety", async () => {
  const root = path.join(scratch, "workspace");
  const cfg: WorkspaceConfig = {
    remoteWorkspaceId: "ws_1",
    projectId: "root",
    deviceId: "dev_1",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
  };
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.mkdir(path.join(root, "local-cache"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify(cfg));
  await fs.writeFile(path.join(root, "local-cache", "ignored.txt"), "ignored");
  await fs.writeFile(path.join(root, "kept.txt"), "kept");
  await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
  await fs.writeFile(folderCatalogPath(), serializeFolderCatalog({
    schemaVersion: 1,
    globalOptions: {},
    folders: [{ name: "workspace", path: root, options: { ignorePaths: ["local-cache"] } }],
  }));

  const state = await inspectFolderCatalog();
  const admission = await observeFolderAdmission(root, state);
  if (admission.kind !== "admitted") throw new Error(admission.reason);
  const resolved = applyFolderPolicy(cfg, admission.policy);
  const matcher = matcherForState(root, resolved);
  expect((await scanManifest(root, matcher)).files.map((entry) => entry.path)).toEqual(["kept.txt"]);
  expect(matcherForState(root, resolved, undefined, { purgeSafety: true }).ignores("local-cache/ignored.txt")).toBe(false);
});
