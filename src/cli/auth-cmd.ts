import os from "node:os";
import { clearCredentials, loadCredentials, saveCredentials } from "./credentials.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJson(url: string, body: unknown, token?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

/** `rbox login [--bootstrap <secret>]` — obtain a per-device token. */
export async function login(remoteUrl: string, bootstrapSecret?: string): Promise<void> {
  const label = os.hostname();
  if (bootstrapSecret) {
    const res = await postJson(`${remoteUrl}/v1/auth/device/bootstrap`, { secret: bootstrapSecret, label });
    if (!res.ok) throw new Error(`bootstrap failed: ${res.status} ${await res.text()}`);
    const { token, deviceId } = (await res.json()) as { token: string; deviceId: string };
    await saveCredentials({ token, deviceId, remoteUrl });
    console.log(`logged in (bootstrapped) as device ${deviceId}`);
    return;
  }

  const startRes = await postJson(`${remoteUrl}/v1/auth/device/start`, { label });
  if (!startRes.ok) throw new Error(`login start failed: ${startRes.status}`);
  const start = (await startRes.json()) as { deviceCode: string; userCode: string; interval: number; expiresIn: number };
  console.log(`\nTo authorize this device, run on an already-signed-in machine:\n`);
  console.log(`    rbox device approve ${start.userCode}\n`);
  console.log(`Waiting for approval (expires in ${start.expiresIn}s)...`);

  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(start.interval * 1000);
    const pollRes = await postJson(`${remoteUrl}/v1/auth/device/poll`, { deviceCode: start.deviceCode });
    const p = (await pollRes.json()) as { status: string; token?: string; deviceId?: string; interval?: number };
    if (p.status === "approved" && p.token) {
      await saveCredentials({ token: p.token, deviceId: p.deviceId ?? "unknown", remoteUrl });
      console.log(`device authorized: ${p.deviceId}`);
      return;
    }
    if (p.status === "expired" || p.status === "not_found") throw new Error("authorization expired — run `rbox login` again");
    // pending → keep polling
  }
  throw new Error("authorization timed out");
}

export async function logout(): Promise<void> {
  await clearCredentials();
  console.log("logged out (credential removed)");
}

async function requireCreds() {
  const creds = await loadCredentials();
  if (!creds) throw new Error("not logged in — run `rbox login` (or `rbox login --bootstrap <secret>`)");
  return creds;
}

/** `rbox device approve <userCode>` — approve another device's pending login. */
export async function approveDevice(userCode: string): Promise<void> {
  const creds = await requireCreds();
  const res = await postJson(`${creds.remoteUrl}/v1/auth/device/approve`, { userCode }, creds.token);
  if (!res.ok) throw new Error(`approve failed: ${res.status} ${await res.text()}`);
  console.log(`approved ${userCode}`);
}

export async function listDevices(): Promise<void> {
  const creds = await requireCreds();
  const res = await fetch(`${creds.remoteUrl}/v1/auth/devices`, { headers: { authorization: `Bearer ${creds.token}` } });
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  const { devices } = (await res.json()) as { devices: Array<{ device_id: string; label: string | null; created_at: number; last_seen_at: number | null; isSelf: boolean }> };
  for (const d of devices) {
    const seen = d.last_seen_at ? new Date(d.last_seen_at).toISOString() : "never";
    console.log(`${d.isSelf ? "* " : "  "}${d.device_id}  ${d.label ?? ""}  last-seen ${seen}`);
  }
}

export async function revokeDevice(deviceId: string): Promise<void> {
  const creds = await requireCreds();
  const res = await postJson(`${creds.remoteUrl}/v1/auth/devices/${deviceId}/revoke`, {}, creds.token);
  if (!res.ok) throw new Error(`revoke failed: ${res.status}`);
  console.log(`revoked ${deviceId}`);
}
