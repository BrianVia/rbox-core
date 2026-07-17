import { mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let materializeCalls = 0;
mock.module("./agent-key-bundle.js", () => ({
  decodeAgentKeyBundle: () => ({
    v: 1, kind: "agent", bearer: "token", accountId: "acct", deviceId: "dev",
    remoteUrl: "https://api.test", device: {}, mk: "mk", keks: [],
  }),
  materializeAgentKey: async () => {
    materializeCalls++;
    throw new Error("key materialization must not run");
  },
}));
mock.module("./workspace-picker.js", () => ({
  fetchAccountWorkspaces: async () => [{ workspaceId: "ws_new", projectId: "root", name: "New workspace", createdAt: 1 }],
  promptWorkspacePick: async () => undefined,
}));

const { runKeyedSetup } = await import("./setup-keyed.js");
const { saveConfig } = await import("./config.js");
const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-keyed-rebind-"));
const target = path.join(cwd, "target");
try {
  await fs.mkdir(target);
  await saveConfig(target, {
    schema: "e2ee/v1", remoteWorkspaceId: "ws_old", projectId: "root", deviceId: "dev_old",
    rootPath: target, remoteUrl: "https://api.test", token: "",
  });
  await fs.writeFile(path.join(target, "sentinel"), "unchanged");
  const before = (await fs.readdir(target)).sort();
  process.env.RBOX_KEY = "mock-bundle";
  process.env.RBOX_HOME = "unchanged-home";
  let refused = false;
  try {
    await runKeyedSetup(cwd, "https://api.test", { workspace: "ws_new", dir: "target", force: "true" });
  } catch (error) {
    refused = error instanceof Error && error.message.includes("without setup confirmation");
  }
  process.stdout.write(JSON.stringify({
    refused,
    materializeCalls,
    targetUnchanged: JSON.stringify((await fs.readdir(target)).sort()) === JSON.stringify(before),
    sentinel: await fs.readFile(path.join(target, "sentinel"), "utf8"),
    home: process.env.RBOX_HOME,
  }));
} finally {
  await fs.rm(cwd, { recursive: true, force: true });
}
