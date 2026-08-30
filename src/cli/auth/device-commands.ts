
import { emitJson } from "../json.js";
import { friendlyHttpError } from "../http-error.js";


import { confirmDestructive } from "../prompt.js";
import { requireCreds } from "./session.js";
import { approveDeviceAuth, listDevicesAuth, revokeDeviceAuth } from "../remote/auth-command-wire.js";

export async function approveDevice(userCode: string): Promise<void> {
  const creds = await requireCreds();
  const res = await approveDeviceAuth(creds.remoteUrl, userCode, creds.token);
  if (!res.ok) throw await friendlyHttpError(res, "device approve");
  console.log(`approved ${userCode}`);
}

export async function listDevices(opts: { json?: boolean } = {}): Promise<void> {
  const creds = await requireCreds();
  const res = await listDevicesAuth(creds.remoteUrl, creds.token);
  if (!res.ok) throw await friendlyHttpError(res, "device list");
  const { devices } = (await res.json()) as { devices: Array<{ device_id: string; label: string | null; created_at: number; last_seen_at: number | null; last_seen_version?: string | null; isSelf: boolean }> };
  if (opts.json) {
    emitJson({
      devices: devices.map((d) => ({
        id: d.device_id,
        kind: "cli",
        createdAt: d.created_at,
        lastSeenAt: d.last_seen_at,
        lastSeenVersion: d.last_seen_version ?? null,
        revoked: false,
      })),
    });
    return;
  }
  for (const d of devices) {
    const seen = d.last_seen_at ? new Date(d.last_seen_at).toISOString() : "never";
    console.log(`${d.isSelf ? "* " : "  "}${d.device_id}  ${d.label ?? ""}  version ${d.last_seen_version ?? "—"}  last-seen ${seen}`);
  }
}

export async function revokeDevice(deviceId: string, yes = false): Promise<void> {
  const ok = await confirmDestructive({
    message: `Revoke device ${deviceId}? It loses access to this account and stops syncing.`,
    yes,
    default: false,
    headless: "require-yes",
    headlessError: "refusing to revoke a device without --yes in non-interactive mode",
  });
  if (!ok) throw new Error("cancelled");
  const creds = await requireCreds();
  const res = await revokeDeviceAuth(creds.remoteUrl, deviceId, creds.token);
  if (!res.ok) throw await friendlyHttpError(res, "device revoke");
  console.log(`revoked ${deviceId}`);
}
