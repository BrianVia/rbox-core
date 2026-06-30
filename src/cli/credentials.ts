import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Per-machine rbox credential — the device token obtained via `rbox login`,
 * shared by all workspaces on this machine (a device is a device). Stored in
 * `~/.rbox/credentials.json` with mode 600. The plaintext token lives only here
 * (the server stores only its sha256 hash).
 */
export interface Credentials {
  token: string;
  deviceId: string;
  remoteUrl: string;
  /** The account this device belongs to — namespaces the E2EE keystore. Trusted
   *  only after cross-check against the SIGNED accountId in the roster (D7). */
  accountId?: string;
}

const dir = () => path.join(os.homedir(), ".rbox");
const file = () => path.join(dir(), "credentials.json");

export async function loadCredentials(): Promise<Credentials | undefined> {
  // Env override for CI / headless (no interactive login).
  if (process.env.RBOX_TOKEN) {
    return {
      token: process.env.RBOX_TOKEN,
      deviceId: process.env.RBOX_DEVICE_ID ?? "env",
      remoteUrl: process.env.RBOX_API ?? "https://rbox-dev-api.brian-via.workers.dev",
      accountId: process.env.RBOX_ACCOUNT_ID,
    };
  }
  try {
    return JSON.parse(await fs.readFile(file(), "utf8")) as Credentials;
  } catch {
    return undefined;
  }
}

/** Load the per-machine credential or throw the standard not-logged-in guidance.
 *  Shared by the authed CLI command groups (account, subscribe/billing). */
export async function requireCredentials(): Promise<Credentials> {
  const c = await loadCredentials();
  if (!c) throw new Error("not logged in — run `rbox login` (or `rbox login --bootstrap <secret>`)");
  return c;
}

export async function saveCredentials(c: Credentials): Promise<void> {
  await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(file(), JSON.stringify(c, null, 2), { mode: 0o600 });
  await fs.chmod(file(), 0o600).catch(() => {}); // ensure perms even if file pre-existed
}

export async function clearCredentials(): Promise<void> {
  await fs.rm(file(), { force: true });
}
