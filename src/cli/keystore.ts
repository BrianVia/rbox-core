import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { kekFromPhrase, kekToPhrase } from "../engine/index.js";

/**
 * Per-machine workspace key store: `~/.rbox/keys/<workspaceId>.key` (mode 600).
 * Holds the workspace KEK in plaintext locally — it NEVER leaves the device and
 * is never sent to the server. Lose every copy + the recovery phrase → the
 * encrypted data is unrecoverable (by design).
 */

const dir = () => path.join(os.homedir(), ".rbox", "keys");
const keyPath = (workspaceId: string) => path.join(dir(), `${workspaceId}.key`);

export async function loadKek(workspaceId: string): Promise<Buffer | undefined> {
  try {
    return kekFromPhrase((await fs.readFile(keyPath(workspaceId), "utf8")).trim());
  } catch {
    return undefined;
  }
}

export async function saveKek(workspaceId: string, kek: Buffer): Promise<void> {
  await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(keyPath(workspaceId), kekToPhrase(kek), { mode: 0o600 });
  await fs.chmod(keyPath(workspaceId), 0o600).catch(() => {});
}
