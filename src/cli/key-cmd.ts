import path from "node:path";
import { createPatToken, patDisplayPrefix } from "../engine/pat-token.js";
import { fromB64url, randomBytes, sha256Hex, toB64url, utf8, type DeviceSecrets } from "../engine/e2ee/index.js";
import { loadCredentials } from "./credentials.js";
import { admitAgentDevice } from "./e2ee-client.js";
import { loadDevice, saveDevice, saveWsKek } from "./e2ee-keystore.js";
import { RboxApi } from "./remote.js";
import { homeDir } from "./rbox-paths.js";
import { emitJson } from "./json.js";
import { isInteractive, promptConfirm } from "./prompt.js";

const MAX_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;

interface AgentKeyBundle {
  v: 1;
  kind: "agent";
  bearer: string;
  accountId: string;
  deviceId: string;
  remoteUrl?: string;
  device: {
    sigPubKey: string;
    sigPrivPkcs8: string;
    encPubSpki: string;
    encPrivPkcs8: string;
  };
  mk: string;
  mkWrap?: string;
  keks: Array<{ workspaceId: string; keyEpoch: number; kek: string }>;
}

function parseDuration(raw: string | undefined): number {
  if (!raw || raw === "true") throw new Error("usage: rbox key create-ci --expires <duration> (suggested: 90d)");
  const m = /^(\d+)(m|h|d|w|y)$/.exec(raw.trim());
  if (!m) throw new Error("invalid --expires duration; use m, h, d, w, or y (for example 90d)");
  const n = Number(m[1]);
  const unit = m[2]!;
  const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : unit === "w" ? 7 * 86_400_000 : MAX_EXPIRES_MS;
  const ms = n * mult;
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error("invalid --expires duration");
  if (ms > MAX_EXPIRES_MS) throw new Error("--expires must be no more than 1y");
  return ms;
}

function encodeBundle(bundle: AgentKeyBundle): string {
  return toB64url(utf8(JSON.stringify(bundle)));
}

function decodeBundle(raw: string): AgentKeyBundle {
  const b = JSON.parse(new TextDecoder().decode(fromB64url(raw.trim()))) as Partial<AgentKeyBundle>;
  if (b.v !== 1 || b.kind !== "agent" || typeof b.bearer !== "string" || typeof b.accountId !== "string" || typeof b.deviceId !== "string" || typeof b.mk !== "string" || typeof b.device !== "object" || b.device === null) {
    throw new Error("invalid RBOX_KEY bundle");
  }
  return { ...b, keks: Array.isArray(b.keks) ? b.keks : [] } as AgentKeyBundle;
}

function quoteSh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function bundleSecrets(bundle: AgentKeyBundle): DeviceSecrets {
  return {
    accountId: bundle.accountId,
    deviceId: bundle.deviceId,
    sigPubKey: fromB64url(bundle.device.sigPubKey),
    sigPrivPkcs8: fromB64url(bundle.device.sigPrivPkcs8),
    encPubSpki: fromB64url(bundle.device.encPubSpki),
    encPrivPkcs8: fromB64url(bundle.device.encPrivPkcs8),
    mk: fromB64url(bundle.mk),
  };
}

export async function materializeAgentKey(rawBundle: string, opts: { dir?: string; remoteUrlFallback?: string } = {}): Promise<{ home: string; token: string; accountId: string; deviceId: string; remoteUrl?: string }> {
  const bundle = decodeBundle(rawBundle);
  const home = path.resolve(opts.dir ?? process.env.RBOX_HOME ?? homeDir());
  const prevHome = process.env.RBOX_HOME;
  process.env.RBOX_HOME = home;
  try {
    await saveDevice(bundleSecrets(bundle));
    for (const k of bundle.keks) {
      if (typeof k.workspaceId === "string" && Number.isInteger(k.keyEpoch) && typeof k.kek === "string") {
        await saveWsKek(bundle.accountId, k.workspaceId, k.keyEpoch, fromB64url(k.kek));
      }
    }
  } catch (e) {
    if (prevHome === undefined) delete process.env.RBOX_HOME;
    else process.env.RBOX_HOME = prevHome;
    throw e;
  }
  process.env.RBOX_TOKEN = bundle.bearer;
  process.env.RBOX_ACCOUNT_ID = bundle.accountId;
  process.env.RBOX_DEVICE_ID = bundle.deviceId;
  if (bundle.remoteUrl ?? opts.remoteUrlFallback) process.env.RBOX_API = bundle.remoteUrl ?? opts.remoteUrlFallback;
  return { home, token: bundle.bearer, accountId: bundle.accountId, deviceId: bundle.deviceId, remoteUrl: bundle.remoteUrl ?? opts.remoteUrlFallback };
}

export async function materializeCmd(flags: Record<string, string>): Promise<void> {
  if (!process.env.RBOX_KEY) throw new Error("RBOX_KEY is not set");
  const out = await materializeAgentKey(process.env.RBOX_KEY, { dir: flags.dir && flags.dir !== "true" ? flags.dir : undefined });
  console.log(`export RBOX_HOME=${quoteSh(out.home)}`);
  console.log(`export RBOX_TOKEN=${quoteSh(out.token)}`);
  console.log(`export RBOX_ACCOUNT_ID=${quoteSh(out.accountId)}`);
  console.log(`export RBOX_DEVICE_ID=${quoteSh(out.deviceId)}`);
}

async function confirmRootKey(accepted: boolean): Promise<void> {
  const warning =
    "Agent keys are account-root equivalent: the RBOX_KEY bundle carries the Master Key and can decrypt account data. " +
    "Share one key only for pull-only fleets; every writer needs its own key.";
  process.stderr.write(`${warning}\n`);
  if (accepted) return;
  if (!isInteractive()) throw new Error("refusing to create an account-root key without --accept-root-key in non-interactive mode");
  const ok = await promptConfirm({ message: "Create this account-root agent key?", default: false });
  if (!ok) throw new Error("cancelled");
}

export async function createCiKey(flags: Record<string, string>): Promise<void> {
  await confirmRootKey(flags["accept-root-key"] === "true");
  const expiresAt = Date.now() + parseDuration(flags.expires);
  const creds = await loadCredentials();
  if (!creds?.accountId) throw new Error("not logged in or missing account id — run `rbox login` first");
  const loaded = await loadDevice(creds.accountId);
  if (!loaded || !("secrets" in loaded)) throw new Error("this device is not enrolled for encryption — run `rbox pair`/`rbox recover` first");

  const bearer = createPatToken();
  const deviceId = `agent_${toB64url(randomBytes(16))}`;
  const api = new RboxApi(creds.remoteUrl, creds.token, "", "");
  await api.createApiKey({
    tokenHash: await sha256Hex(utf8(bearer)),
    deviceId,
    expiresAt,
    label: flags.label && flags.label !== "true" ? flags.label : "agent",
    displayPrefix: patDisplayPrefix(bearer),
    enrolled: true,
  });
  const admitted = await admitAgentDevice({
    remoteUrl: creds.remoteUrl,
    bearer,
    accountId: creds.accountId,
    deviceId,
    issuer: loaded.secrets,
    expiresAt,
    now: Date.now(),
  }).catch(async (e) => {
    await api.revokeApiKey(deviceId).catch(() => {});
    throw e;
  });
  const bundle: AgentKeyBundle = {
    v: 1,
    kind: "agent",
    bearer,
    accountId: creds.accountId,
    deviceId,
    remoteUrl: creds.remoteUrl,
    device: {
      sigPubKey: toB64url(admitted.secrets.sigPubKey),
      sigPrivPkcs8: toB64url(admitted.secrets.sigPrivPkcs8),
      encPubSpki: toB64url(admitted.secrets.encPubSpki),
      encPrivPkcs8: toB64url(admitted.secrets.encPrivPkcs8),
    },
    mk: toB64url(admitted.secrets.mk),
    mkWrap: JSON.stringify(admitted.mkWrap),
    keks: [],
  };
  console.log(`RBOX_KEY=${encodeBundle(bundle)}`);
}

export async function listKeys(opts: { json?: boolean } = {}): Promise<void> {
  const creds = await loadCredentials();
  if (!creds) throw new Error("not logged in — run `rbox login`");
  const keys = await new RboxApi(creds.remoteUrl, creds.token, "", "").listApiKeys();
  if (opts.json) {
    emitJson({ keys });
    return;
  }
  for (const k of keys) {
    const seen = k.lastSeenAt ? new Date(k.lastSeenAt).toISOString() : "never";
    console.log(`${k.id}  ${k.displayPrefix}  expires ${new Date(k.expiresAt).toISOString()}  last-seen ${seen}${k.revoked ? "  revoked" : ""}`);
  }
}

export async function revokeKey(deviceId: string): Promise<void> {
  if (!deviceId) throw new Error("usage: rbox key revoke <id>");
  const creds = await loadCredentials();
  if (!creds) throw new Error("not logged in — run `rbox login`");
  await new RboxApi(creds.remoteUrl, creds.token, "", "").revokeApiKey(deviceId);
  console.log(`revoked ${deviceId}`);
}

export { decodeBundle as decodeAgentKeyBundle };
