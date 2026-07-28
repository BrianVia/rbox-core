import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  desiredStatePath,
  startDaemonAndRecordDesired,
  stopDaemonAndRecordDesired,
} from "../autostart-cmd.js";

export let home: string;
let roots: string[];

export const creds = (accountId: string) => async () => ({
  state: "valid" as const,
  source: "disk" as const,
  credentials: { v: 1 as const, token: "tok", deviceId: "dev_test", remoteUrl: "https://api.test", accountId },
  legacy: false,
  extensions: {},
});
export const absent = async () => ({ state: "absent" as const, path: "/test/credentials.json" });

export async function writeWorkspaceBinding(root: string, workspaceId: string): Promise<void> {
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".rbox", "workspace.json"),
    JSON.stringify({
      schema: "e2ee/v1",
      remoteWorkspaceId: workspaceId,
      projectId: "root",
      deviceId: "dev_test",
      rootPath: root,
      remoteUrl: "https://api.test",
      token: "",
    })
  );
}

export async function workspace(workspaceId: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-auto-root-"));
  roots.push(root);
  await writeWorkspaceBinding(root, workspaceId);
  return root;
}

export async function fakeBinary(): Promise<string> {
  const binary = path.join(home, ".rbox", "bin", "rbox");
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, "#!/bin/sh\n");
  return binary;
}

export async function recordDesired(root: string, state: "running" | "stopped", accountId: string, at = "2026-07-03T18:00:00.000Z"): Promise<void> {
  const base = { loadCredentials: creds(accountId), now: () => new Date(at) };
  if (state === "running") {
    await startDaemonAndRecordDesired(root, { ...base, startDaemon: async () => "started" });
  } else {
    await stopDaemonAndRecordDesired(root, { ...base, stopDaemon: async () => {} });
  }
}

export async function beforeEachAutostartTest() {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-auto-home-"));
  roots = [];
  process.env.RBOX_HOME = home;
}

export async function afterEachAutostartTest() {
  delete process.env.RBOX_HOME;
  await fs.rm(home, { recursive: true, force: true });
  await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true })));
}
