import path from "node:path";
import { fromB64url, toB64url, utf8, type DeviceSecrets } from "../engine/e2ee/index.js";
import { saveDevice, saveWsKek } from "./e2ee-keystore.js";
import { homeDir } from "./rbox-paths.js";

export interface AgentKeyBundle {
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
  keks: Array<{ workspaceId: string; keyEpoch: number; kek: string }>;
}

export function encodeAgentKeyBundle(bundle: AgentKeyBundle): string {
  return toB64url(utf8(JSON.stringify(bundle)));
}

export function decodeAgentKeyBundle(raw: string): AgentKeyBundle {
  const b = JSON.parse(new TextDecoder().decode(fromB64url(raw.trim()))) as Partial<AgentKeyBundle>;
  if (b.v !== 1 || b.kind !== "agent" || typeof b.bearer !== "string" || typeof b.accountId !== "string" || typeof b.deviceId !== "string" || typeof b.mk !== "string" || typeof b.device !== "object" || b.device === null) {
    throw new Error("invalid RBOX_KEY bundle");
  }
  return {
    v: 1,
    kind: "agent",
    bearer: b.bearer,
    accountId: b.accountId,
    deviceId: b.deviceId,
    ...(typeof b.remoteUrl === "string" ? { remoteUrl: b.remoteUrl } : {}),
    device: b.device as AgentKeyBundle["device"],
    mk: b.mk,
    keks: Array.isArray(b.keks) ? b.keks : [],
  };
}

export function bundleSecrets(bundle: AgentKeyBundle): DeviceSecrets {
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
  const bundle = decodeAgentKeyBundle(rawBundle);
  const home = path.resolve(opts.dir ?? process.env.RBOX_HOME ?? homeDir());
  const remoteUrl = bundle.remoteUrl ?? opts.remoteUrlFallback;

  // This mutates process.env because credentials.ts/e2ee-keystore.ts read env; that is the headless seam.
  process.env.RBOX_HOME = home;
  process.env.RBOX_TOKEN = bundle.bearer;
  process.env.RBOX_ACCOUNT_ID = bundle.accountId;
  process.env.RBOX_DEVICE_ID = bundle.deviceId;
  if (remoteUrl) process.env.RBOX_API = remoteUrl;

  await saveDevice(bundleSecrets(bundle));
  for (const k of bundle.keks) {
    if (typeof k.workspaceId === "string" && Number.isInteger(k.keyEpoch) && typeof k.kek === "string") {
      await saveWsKek(bundle.accountId, k.workspaceId, k.keyEpoch, fromB64url(k.kek));
    }
  }
  return { home, token: bundle.bearer, accountId: bundle.accountId, deviceId: bundle.deviceId, remoteUrl };
}
