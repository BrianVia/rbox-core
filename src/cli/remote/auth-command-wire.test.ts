import { afterEach, expect, test } from "bun:test";
import {
  acknowledgeKeyDeliveryAuth,
  approveDeviceAuth,
  bootstrapDeviceAuth,
  createPairAuth,
  listDevicesAuth,
  pollDeviceAuth,
  revokeDeviceAuth,
  startDeviceAuth,
} from "./auth-command-wire.js";

const originalFetch = globalThis.fetch;
const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});

function captureFetch(): void {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
}

test("public device-code requests preserve their exact URL, body, and content-type-only headers", async () => {
  captureFetch();
  await startDeviceAuth("https://api.test", { label: "l", encPubKey: "e", sigPubKey: "s" });
  await pollDeviceAuth("https://api.test", "dc");
  await bootstrapDeviceAuth("https://api.test", { secret: "secret", label: "l", plan: "pro" });

  expect(calls).toEqual([
    {
      input: "https://api.test/v1/auth/device/start",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"label":"l","encPubKey":"e","sigPubKey":"s"}',
        signal: expect.any(AbortSignal),
      },
    },
    {
      input: "https://api.test/v1/auth/device/poll",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"deviceCode":"dc"}',
        signal: expect.any(AbortSignal),
      },
    },
    {
      input: "https://api.test/v1/auth/device/bootstrap",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"secret":"secret","label":"l","plan":"pro"}',
        signal: expect.any(AbortSignal),
      },
    },
  ]);
});

test("authenticated auth requests preserve bearer placement and request bodies", async () => {
  captureFetch();
  await acknowledgeKeyDeliveryAuth("https://api.test", "req", "tok");
  await approveDeviceAuth("https://api.test", "CODE", "tok");
  await listDevicesAuth("https://api.test", "tok");
  await createPairAuth("https://api.test", { tokenId: "id", mkWrap: "mk", admissionGrant: "grant" }, "tok");
  await revokeDeviceAuth("https://api.test", "dev", "tok");

  expect(calls.every(({ init }) => init?.signal instanceof AbortSignal)).toBe(true);
  expect(calls.map(({ input, init }) => ({ input, method: init?.method, headers: init?.headers, body: init?.body }))).toEqual([
    { input: "https://api.test/v1/auth/key-delivery/ack", method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: '{"requestId":"req"}' },
    { input: "https://api.test/v1/auth/device/approve", method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: '{"userCode":"CODE"}' },
    { input: "https://api.test/v1/auth/devices", method: undefined, headers: { authorization: "Bearer tok" }, body: undefined },
    { input: "https://api.test/v1/auth/pair/create", method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: '{"tokenId":"id","mkWrap":"mk","admissionGrant":"grant"}' },
    { input: "https://api.test/v1/auth/devices/dev/revoke", method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: "{}" },
  ]);
});
