import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { enrollViaPairing, parsePairingToken } from "./e2ee-client.js";

const origFetch = globalThis.fetch;
const origRboxHome = process.env.RBOX_HOME;
let testHome: string;

beforeEach(async () => {
  testHome = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-e2ee-client-"));
  process.env.RBOX_HOME = testHome;
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  if (origRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = origRboxHome;
  await fs.rm(testHome, { recursive: true, force: true });
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

test("shared pairing parser accepts current, raw, legacy, padded, unpadded, and standard-base64 vectors", () => {
  const urlSecret = Buffer.alloc(32, 0xfb).toString("base64url");
  const standardSecret = Buffer.alloc(32, 0xfb).toString("base64");
  const vectors = [
    `rbox-pair_${"a".repeat(16)}.${urlSecret}`,
    `${"b".repeat(16)}.${urlSecret}`,
    `rbox-pair_${"c".repeat(64)}.${urlSecret}`,
    `${"d".repeat(64)}.${urlSecret}`,
    `rbox-pair_${"e".repeat(16)}.${standardSecret}`,
    `rbox-pair_${"f".repeat(16)}.${urlSecret.slice(0, 12)}    ${urlSecret.slice(12)}`,
  ];
  for (const vector of vectors) expect(parsePairingToken(vector).tokenSecret).toHaveLength(32);
  expect(parsePairingToken(`  ${vectors[0]}  `.trim()).tokenSecret).toHaveLength(32);
});

test("shared pairing parser rejects malformed vectors locally with zero redeem fetches", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  const secret = Buffer.alloc(32).toString("base64url");
  const bad = [
    "",
    `rbox-pair_${"a".repeat(16)}`,
    `rbox-pair_${"a".repeat(16)}.${secret}.extra`,
    `rbox-pair_short.${secret}`,
    `rbox-pair_${"a".repeat(65)}.${secret}`,
    `rbox-pair_${"!".repeat(16)}.${secret}`,
    `rbox-pair_${"a".repeat(16)}.${secret.slice(0, -1)}*`,
    `rbox-pair_${"a".repeat(16)}.${Buffer.alloc(31).toString("base64url")}`,
    `rbox-pair_${"a".repeat(16)}.${Buffer.alloc(33).toString("base64url")}`,
  ];
  for (const vector of bad) {
    expect(() => parsePairingToken(vector)).toThrow(/malformed pairing token/);
    await expect(enrollViaPairing("https://api.test", vector, 1)).rejects.toThrow(/malformed pairing token/);
    expect(fetches).toBe(0);
  }
});
