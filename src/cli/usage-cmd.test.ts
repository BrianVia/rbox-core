import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { usageCmd, type AccountUsageDTO } from "./usage-cmd.js";

const origFetch = globalThis.fetch;
const origLog = console.log;
let calls: { url: string; init?: RequestInit }[] = [];
let logs: string[] = [];

const dto: AccountUsageDTO = {
  plan: "none",
  usedBytes: 1,
  storageCap: 1,
  workspaces: 1,
  workspaceCap: 1,
  retentionDays: 0,
  graceUntil: null,
  readOnly: true,
};

function stub(body: string, status = 200): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  logs = [];
  console.log = (...m: unknown[]) => void logs.push(m.map(String).join(" "));
  process.env.RBOX_TOKEN = "durable-token";
  process.env.RBOX_API = "https://api.test";
  process.env.RBOX_DEVICE_ID = "dev_test";
});

afterEach(() => {
  globalThis.fetch = origFetch;
  console.log = origLog;
  delete process.env.RBOX_TOKEN;
  delete process.env.RBOX_API;
  delete process.env.RBOX_DEVICE_ID;
});

describe("rbox usage", () => {
  test("--json prints the account usage DTO body verbatim, including null caps", async () => {
    const raw = JSON.stringify({ ...dto, storageCap: null, workspaceCap: null });
    stub(raw);
    await usageCmd({ json: true });
    expect(calls[0]!.url).toBe("https://api.test/v1/account/usage");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer durable-token");
    expect(logs).toEqual([raw]);
  });

  test("human render derives percent and read-only annotation from storage usage", async () => {
    stub(JSON.stringify(dto));
    await usageCmd();
    const out = logs[0]!;
    expect(out).toContain("plan:       no active plan");
    expect(out).toContain("storage:    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  1 B / 1 B   (100%, still being measured, read-only)");
    expect(out).toContain("workspaces: 1 / 1");
    expect(out).toContain("retention:  0 days (current state only)");
    expect(out).not.toContain("grace:");
    expect(out).toContain("read-only:  yes (over quota or subscription lapsed — pushes are blocked)");
  });

  test("storage carries the age of the measurement it came from", async () => {
    const now = Date.now();
    stub(JSON.stringify({ ...dto, measuredAt: now - 41 * 60_000, readOnly: false }));
    await usageCmd();
    expect(logs[0]!).toContain("(100%, measured 41 minutes ago)");

    logs.length = 0;
    stub(JSON.stringify({ ...dto, measuredAt: now - 3 * 3600_000, readOnly: false }));
    await usageCmd();
    expect(logs[0]!).toContain("(100%, measured 3 hours ago)");
  });

  test("human render explains an active billing grace period", async () => {
    stub(JSON.stringify({ ...dto, graceUntil: 1_700_000_000_000, readOnly: false }));
    await usageCmd();
    const out = logs[0]!;
    expect(out).toContain("grace:      until 2023-11-14T22:13:20.000Z (billing lapsed — syncing keeps working until then)");
    expect(out).not.toContain("read-only:");
  });
});
