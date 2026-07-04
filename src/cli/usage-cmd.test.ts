import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { usageCmd, type AccountUsageDTO } from "./usage-cmd.js";

const origFetch = globalThis.fetch;
const origLog = console.log;
let calls: { url: string; init?: RequestInit }[] = [];
let logs: string[] = [];

const dto: AccountUsageDTO = {
  plan: "free",
  usedBytes: 2 * 1024 * 1024 * 1024,
  storageCap: 2 * 1024 * 1024 * 1024,
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
    expect(out).toContain("plan:       free");
    expect(out).toContain("storage:    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  2.0 GiB / 2.0 GiB   (100%, read-only)");
    expect(out).toContain("workspaces: 1 / 1");
    expect(out).toContain("retention:  0 days (current state only)");
    expect(out).toContain("grace:      none");
    expect(out).toContain("read-only:  yes");
  });
});
