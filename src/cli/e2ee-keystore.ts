import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fromB64url, toB64url, type DeviceSecrets, type Wrap } from "../engine/e2ee/index.js";

/**
 * Per-machine E2EE key material (design 12 §13.1), mode 600 under
 * `~/.rbox/e2ee/<accountId>/`:
 *   - `device.json` — this device's identity (deviceId + sig/enc keypairs).
 *   - `mk.key`      — the Account Master Key. Kept SEPARATE from device.json so a
 *                     `device.json`-without-`mk.key` state is detectable (C10): MK
 *                     is re-derivable from the device's own server-stored RSA wrap.
 *   - `rk.key`      — recovery key, ONLY if the user opted into caching (C9). Not
 *                     written by default; the phrase is shown once at bootstrap.
 *   - `ws/<id>.json`— `{ keyEpoch → kekB64 }` cache of unwrapped workspace KEKs
 *                     (re-derivable from MK; authoritative copy is the server wrap).
 *
 * MK/RK/KEK live in plaintext files (mode 600) exactly as M5's KEK did — the
 * zero-knowledge property is about the SERVER, not local disk. OS-keychain
 * storage is future hardening.
 */

// `RBOX_HOME` overrides the home dir (tests; also lets a user relocate state).
const home = () => process.env.RBOX_HOME || os.homedir();
const root = (accountId: string) => path.join(home(), ".rbox", "e2ee", accountId);
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

interface DeviceJson {
  deviceId: string;
  sigPubKey: string;
  sigPrivPkcs8: string;
  encPubSpki: string;
  encPrivPkcs8: string;
}

async function writeSecret(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE });
  await fs.writeFile(file, data, { mode: FILE_MODE });
  await fs.chmod(file, FILE_MODE).catch(() => {});
}

async function readMaybe(file: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(file, "utf8")).trim();
  } catch {
    return undefined;
  }
}

/** True iff this machine has a device identity for the account (C10 routing). */
export async function hasDevice(accountId: string): Promise<boolean> {
  return (await readMaybe(path.join(root(accountId), "device.json"))) !== undefined;
}

/**
 * Load the full device secrets, or report a partial state. Returns:
 *  - `{ secrets }` when both device.json and mk.key are present;
 *  - `{ device }` (no MK) when device.json exists but mk.key is missing — the
 *    caller must re-derive MK from the server wrap (C10), then `saveMasterKey`;
 *  - `undefined` when there's no device identity at all (must pair/recover).
 */
export async function loadDevice(accountId: string): Promise<{ secrets: DeviceSecrets } | { device: Omit<DeviceSecrets, "mk"> } | undefined> {
  const raw = await readMaybe(path.join(root(accountId), "device.json"));
  if (!raw) return undefined;
  const d = JSON.parse(raw) as DeviceJson;
  const device: Omit<DeviceSecrets, "mk"> = {
    accountId,
    deviceId: d.deviceId,
    sigPubKey: fromB64url(d.sigPubKey),
    sigPrivPkcs8: fromB64url(d.sigPrivPkcs8),
    encPubSpki: fromB64url(d.encPubSpki),
    encPrivPkcs8: fromB64url(d.encPrivPkcs8),
  };
  const mkB64 = await readMaybe(path.join(root(accountId), "mk.key"));
  if (!mkB64) return { device };
  return { secrets: { ...device, mk: fromB64url(mkB64) } };
}

export async function saveDevice(secrets: DeviceSecrets): Promise<void> {
  const dir = root(secrets.accountId);
  const device: DeviceJson = {
    deviceId: secrets.deviceId,
    sigPubKey: toB64url(secrets.sigPubKey),
    sigPrivPkcs8: toB64url(secrets.sigPrivPkcs8),
    encPubSpki: toB64url(secrets.encPubSpki),
    encPrivPkcs8: toB64url(secrets.encPrivPkcs8),
  };
  await writeSecret(path.join(dir, "device.json"), JSON.stringify(device, null, 2));
  await saveMasterKey(secrets.accountId, secrets.mk);
}

export async function saveMasterKey(accountId: string, mk: Uint8Array): Promise<void> {
  await writeSecret(path.join(root(accountId), "mk.key"), toB64url(mk));
}

// ---- workspace KEK cache --------------------------------------------------

export async function loadWsKek(accountId: string, workspaceId: string, keyEpoch: number): Promise<Uint8Array | undefined> {
  const raw = await readMaybe(path.join(root(accountId), "ws", `${workspaceId}.json`));
  if (!raw) return undefined;
  const map = JSON.parse(raw) as Record<string, string>;
  const b64 = map[String(keyEpoch)];
  return b64 ? fromB64url(b64) : undefined;
}

export async function saveWsKek(accountId: string, workspaceId: string, keyEpoch: number, kek: Uint8Array): Promise<void> {
  const file = path.join(root(accountId), "ws", `${workspaceId}.json`);
  const raw = await readMaybe(file);
  const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  map[String(keyEpoch)] = toB64url(kek);
  await writeSecret(file, JSON.stringify(map));
}

// ---- recovery key (opt-in caching, C9) ------------------------------------

export async function saveRecoveryKey(accountId: string, rk: Uint8Array): Promise<void> {
  await writeSecret(path.join(root(accountId), "rk.key"), toB64url(rk));
}

export async function loadRecoveryKey(accountId: string): Promise<Uint8Array | undefined> {
  const b64 = await readMaybe(path.join(root(accountId), "rk.key"));
  return b64 ? fromB64url(b64) : undefined;
}

export async function forgetRecoveryKey(accountId: string): Promise<void> {
  await fs.rm(path.join(root(accountId), "rk.key"), { force: true });
}
