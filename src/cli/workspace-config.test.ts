import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig, type WorkspaceConfig } from "./workspace-config.js";

test("workspace config persistence is byte-stable and strips every runtime secret", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-workspace-config-"));
  const config: WorkspaceConfig = {
    schema: "e2ee/v1",
    remoteWorkspaceId: "workspace",
    name: "Local name",
    projectId: "root",
    deviceId: "device",
    rootPath: root,
    remoteUrl: "https://api.example",
    token: "secret-token",
    syncGit: true,
    encrypted: true,
    kek: Buffer.from("secret-kek"),
    accountId: "account",
    accountEpoch: 7,
    keyEpoch: 9,
    trash: { days: 14, maxBytes: 1024 },
  };

  await saveConfig(root, config);

  const expected = JSON.stringify({
    schema: "e2ee/v1",
    remoteWorkspaceId: "workspace",
    name: "Local name",
    projectId: "root",
    deviceId: "device",
    rootPath: root,
    remoteUrl: "https://api.example",
    token: "",
    syncGit: true,
    encrypted: true,
    trash: { days: 14, maxBytes: 1024 },
  }, null, 2);
  expect(await fs.readFile(path.join(root, ".rbox", "workspace.json"), "utf8")).toBe(expected);
});
