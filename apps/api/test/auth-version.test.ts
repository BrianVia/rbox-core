import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";

const BASE = "https://example.com";
const THROTTLE_MS = 10 * 60 * 1000;

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

async function bootstrap(name: string): Promise<{ token: string; deviceId: string }> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; deviceId: string };
}

function request(token: string, version?: string): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (version !== undefined) headers["x-rbox-version"] = version;
  return SELF.fetch(`${BASE}/v1/auth/devices`, { headers });
}

async function setSeen(deviceId: string, at: number, version: string | null): Promise<void> {
  await env.rbox_dev_db
    .prepare("UPDATE devices SET last_seen_at = ?, last_seen_version = ? WHERE device_id = ?")
    .bind(at, version, deviceId)
    .run();
}

async function seen(deviceId: string): Promise<{ last_seen_at: number; last_seen_version: string | null }> {
  return (await env.rbox_dev_db
    .prepare("SELECT last_seen_at, last_seen_version FROM devices WHERE device_id = ?")
    .bind(deviceId)
    .first<{ last_seen_at: number; last_seen_version: string | null }>())!;
}

describe("authenticated CLI version tracking", () => {
  test("unchanged versions are throttled, changes write past the 60s floor, and device JSON exposes the field", async () => {
    const a = await bootstrap("version-throttle");
    // Older than the 60s change floor, younger than the 10min throttle.
    const recent = Date.now() - 90_000;
    await setSeen(a.deviceId, recent, "1.2.3");

    expect((await request(a.token, "1.2.3")).status).toBe(200);
    expect(await seen(a.deviceId)).toEqual({ last_seen_at: recent, last_seen_version: "1.2.3" });

    const changed = await request(a.token, "1.2.4");
    expect(changed.status).toBe(200);
    expect(await seen(a.deviceId)).toMatchObject({ last_seen_version: "1.2.4" });
    expect((await seen(a.deviceId)).last_seen_at).not.toBe(recent);
    const body = (await changed.json()) as { devices: Array<{ device_id: string; last_seen_version: string | null }> };
    expect(body.devices.find((d) => d.device_id === a.deviceId)?.last_seen_version).toBe("1.2.4");
  });

  test("a changed version within the 60s floor does NOT write (mixed-version ping-pong damping)", async () => {
    const a = await bootstrap("version-floor");
    const fresh = Date.now() - 5_000;
    await setSeen(a.deviceId, fresh, "1.2.3");

    expect((await request(a.token, "1.2.4")).status).toBe(200);
    expect(await seen(a.deviceId)).toEqual({ last_seen_at: fresh, last_seen_version: "1.2.3" });
  });

  test("a stale unchanged version refreshes the timestamp in the throttled write", async () => {
    const a = await bootstrap("version-stale");
    const stale = Date.now() - THROTTLE_MS - 1_000;
    await setSeen(a.deviceId, stale, "2.0.0");

    expect((await request(a.token, "2.0.0")).status).toBe(200);
    expect((await seen(a.deviceId)).last_seen_at).toBeGreaterThan(stale);
    expect((await seen(a.deviceId)).last_seen_version).toBe("2.0.0");
  });

  test("a missing header preserves an existing version even during a stale update", async () => {
    const a = await bootstrap("version-missing");
    const stale = Date.now() - THROTTLE_MS - 1_000;
    await setSeen(a.deviceId, stale, "3.4.5");

    expect((await request(a.token)).status).toBe(200);
    const row = await seen(a.deviceId);
    expect(row.last_seen_at).toBeGreaterThan(stale);
    expect(row.last_seen_version).toBe("3.4.5");
  });

  test("strict validation accepts the specified edge and preserves the stored version for malformed-present values", async () => {
    const a = await bootstrap("version-validation");
    const recent = Date.now() - 90_000; // past the 60s change floor

    await setSeen(a.deviceId, recent, "9.9.9");
    expect((await request(a.token, "1.2.3-")).status).toBe(200);
    expect((await seen(a.deviceId)).last_seen_version).toBe("1.2.3-");

    const malformed = [
      "1.2.3 evil",
      "1.2",
      "1.2.3_bad",
      "1.2.3/evil",
      "1.2.3-é",
      `${"1".repeat(45)}.2.3`,
    ];
    for (const value of malformed) {
      await setSeen(a.deviceId, recent, "9.9.9");
      expect((await request(a.token, value)).status).toBe(200);
      expect((await seen(a.deviceId)).last_seen_version, value).toBe("9.9.9");
    }
  });
});
