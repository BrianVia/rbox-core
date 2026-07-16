import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { enrollViaPairing } from "./e2ee-client.js";

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("enrollViaPairing redeem errors", () => {
  test("device_limit_reached 409 explains the pairing token is still valid", async () => {
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      expect(String(input)).toBe("https://api.test/v1/auth/pair/redeem");
      expect(JSON.parse(String(init?.body))).toEqual({ token: `rbox-pair_${"a".repeat(16)}`, label: "rig-b-onboard-smoke" });
      return new Response(JSON.stringify({ error: "device_limit_reached", cap: 2, plan: "none" }), { status: 409 });
    }) as typeof fetch;

    const secret = Buffer.alloc(32).toString("base64url");
    await expect(enrollViaPairing("https://api.test", `rbox-pair_${"a".repeat(16)}.${secret}`, 1, "rig-b-onboard-smoke")).rejects.toThrow(
      "device limit reached (2/2 on none) — revoke a device or upgrade; pairing token still valid"
    );
    expect(calls).toBe(1);
  });
});
