import { env, applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { stripeWebhook, stripeWebhookMaxBytes } from "../src/stripe.js";
import type { Env } from "../src/env.js";

const SECRET = "whsec_unit2";
const NOW_MS = 1_800_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const CAP = 1024 * 1024;
const encoder = new TextEncoder();
const ctx: Pick<ExecutionContext, "waitUntil"> = { waitUntil: (promise) => void promise };
const handlerEnv = (): Env => ({ ...env, STRIPE_WEBHOOK_SECRET: SECRET } as Env);

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function signature(bytes: Uint8Array): string {
  return `t=${NOW_S},v1=${createHmac("sha256", SECRET).update(String(NOW_S)).update(".").update(bytes).digest("hex")}`;
}

function request(bytes: Uint8Array, headers: Record<string, string> = {}): Request {
  return new Request("https://api.rbox.to/v1/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": signature(bytes), "content-type": "application/json", ...headers },
    body: bytes.buffer as ArrayBuffer,
  });
}

function exactEventBytes(size: number, id: string): Uint8Array {
  const event = { id, type: "unit2.ignored", data: { object: {} }, padding: "" };
  const base = JSON.stringify(event);
  const needed = size - encoder.encode(base).byteLength;
  if (needed < 0) throw new Error("fixture size too small");
  event.padding = "x".repeat(needed);
  const bytes = encoder.encode(JSON.stringify(event));
  if (bytes.byteLength !== size) throw new Error("fixture size mismatch");
  return bytes;
}

describe("Stripe bounded raw webhook", () => {
  test("validated environment cap defaults safely and accepts only positive decimal safe integers", () => {
    expect(stripeWebhookMaxBytes({})).toBe(CAP);
    for (const value of ["", "0", "-1", "1e6", "12junk", "9007199254740992"]) {
      expect(stripeWebhookMaxBytes({ RBOX_STRIPE_WEBHOOK_MAX_BYTES: value })).toBe(CAP);
    }
    expect(stripeWebhookMaxBytes({ RBOX_STRIPE_WEBHOOK_MAX_BYTES: "2048" })).toBe(2048);
  });

  test("accepts an exactly 1 MiB complete body", async () => {
    const bytes = exactEventBytes(CAP, "evt_unit2_exact");
    const response = await stripeWebhook(request(bytes), handlerEnv(), NOW_MS, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
  });

  test("overflow by one byte returns 413 before signature verification or parsing", async () => {
    const bytes = exactEventBytes(CAP + 1, "evt_unit2_over");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await stripeWebhook(request(bytes, {
      "stripe-signature": "secret-material-must-not-log",
      "content-length": String(CAP + 1),
    }), handlerEnv(), NOW_MS, ctx);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "body_too_large" });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]![0] as string;
    expect(JSON.parse(line)).toEqual({ event: "stripe_webhook_body_overflow", contentLength: CAP + 1, bytesCounted: 0, signaturePresent: true });
    expect(line).not.toContain("secret-material");
    expect(line).not.toContain("padding");
    expect(line).not.toMatch(/cap.?evidence|raise/i);
  });

  test("chunked understated overflow logs the observed count once and cancels", async () => {
    let cancelled = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = new Request("https://api.rbox.to/v1/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "present", "content-length": "1" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(CAP));
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    });
    const response = await stripeWebhook(req, handlerEnv(), NOW_MS, ctx);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
      event: "stripe_webhook_body_overflow",
      contentLength: 1,
      bytesCounted: CAP + 1,
      signaturePresent: true,
    });
  });

  test("overflow without signature or Content-Length logs nullable/absent metadata", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = new Request("https://api.rbox.to/v1/stripe/webhook", { method: "POST", body: new Uint8Array([1, 2]).buffer });
    const response = await stripeWebhook(req, { ...handlerEnv(), RBOX_STRIPE_WEBHOOK_MAX_BYTES: "1" }, NOW_MS, ctx);
    expect(response.status).toBe(413);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
      event: "stripe_webhook_body_overflow",
      contentLength: null,
      bytesCounted: 2,
      signaturePresent: false,
    });
  });

  test("signature verification uses exact original bytes before ordinary decoding", async () => {
    const bytes = exactEventBytes(256, "evt_unit2_exact_bytes");
    const marker = bytes.lastIndexOf("x".charCodeAt(0));
    bytes[marker] = 0xff; // invalid UTF-8 inside a JSON string; decoding produces U+FFFD after verification
    const response = await stripeWebhook(request(bytes), handlerEnv(), NOW_MS, ctx);
    expect(response.status).toBe(200);
  });

  test("bad signature wins before JSON parse; a valid signature reaches the existing parse error", async () => {
    const malformed = encoder.encode("not-json");
    const bad = request(malformed, { "stripe-signature": `t=${NOW_S},v1=${"0".repeat(64)}` });
    const badResponse = await stripeWebhook(bad, handlerEnv(), NOW_MS, ctx);
    expect(badResponse.status).toBe(400);
    expect(await badResponse.json()).toEqual({ error: "bad_signature" });
    await expect(stripeWebhook(request(malformed), handlerEnv(), NOW_MS, ctx)).rejects.toBeInstanceOf(SyntaxError);
  });

  test("reader errors rethrow and never emit the overflow anomaly", async () => {
    const failure = new Error("reader failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = new Request("https://api.rbox.to/v1/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "present" },
      body: new ReadableStream({ pull(controller) { controller.error(failure); } }),
    });
    await expect(stripeWebhook(req, handlerEnv(), NOW_MS, ctx)).rejects.toBe(failure);
    expect(warn).not.toHaveBeenCalled();
  });
});
