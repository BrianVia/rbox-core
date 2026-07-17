import { mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let selectedWorkspace;
let directoryAnswer = "";
const confirmations = [];
mock.module("./prompt.js", () => ({
  isInteractive: () => true,
  promptInput: async () => directoryAnswer,
  promptConfirm: async (config) => { confirmations.push(config.message); return false; },
  promptSelect: async () => "none",
  promptSearch: async () => undefined,
  promptPassword: async () => "",
  cancelableSelect: () => ({ cancel: () => {} }),
}));
mock.module("./workspace-picker.js", () => ({
  promptWorkspacePick: async () => selectedWorkspace,
  fetchAccountWorkspaces: async () => [],
}));

const { runSetup } = await import("./setup-cmd.js");
const { saveConfig } = await import("./config.js");
Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
process.env.RBOX_TOKEN = "token";
process.env.RBOX_DEVICE_ID = "dev";
process.env.RBOX_API = "https://api.test";
const roots = [];
async function boundRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-guided-rebind-"));
  roots.push(root);
  await saveConfig(root, {
    schema: "e2ee/v1", remoteWorkspaceId: "ws_old", projectId: "root", deviceId: "dev_old",
    rootPath: root, remoteUrl: "https://api.test", token: "",
  });
  return root;
}
try {
  const createRoot = await boundRoot();
  directoryAnswer = createRoot;
  await runSetup({ cwd: createRoot, defaultRemote: "https://api.test", viaUntrackedMenu: true, preselectedWorkspaceKind: "new" });
  const createBinding = JSON.parse(await fs.readFile(path.join(createRoot, ".rbox", "workspace.json"), "utf8")).remoteWorkspaceId;

  const existingRoot = await boundRoot();
  directoryAnswer = existingRoot;
  selectedWorkspace = { workspaceId: "ws_new", name: "New workspace" };
  await runSetup({ cwd: existingRoot, defaultRemote: "https://api.test", viaUntrackedMenu: true, preselectedWorkspaceKind: "existing" });
  const existingBinding = JSON.parse(await fs.readFile(path.join(existingRoot, ".rbox", "workspace.json"), "utf8")).remoteWorkspaceId;
  process.stdout.write(JSON.stringify({ confirmations, createBinding, existingBinding }));
} finally {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
}
