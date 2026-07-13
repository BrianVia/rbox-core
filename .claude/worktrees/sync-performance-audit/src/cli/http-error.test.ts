import { afterEach, expect, test } from "bun:test";
import { friendlyHttpError } from "./http-error.js";

const originalDebug = process.env.RBOX_DEBUG;

afterEach(() => {
  if (originalDebug === undefined) delete process.env.RBOX_DEBUG;
  else process.env.RBOX_DEBUG = originalDebug;
});

test.each([
  [401, "request failed: this device isn't authorized (HTTP 401) — run `rbox login` again"],
  [404, "request failed: the server didn't recognize this request (HTTP 404) — check the value you passed and try again"],
  [429, "request failed: rate-limited — wait a moment and try again"],
  [500, "request failed: the rbox service hit a problem (HTTP 500) — try again shortly"],
  [418, "request failed (HTTP 418)"],
])("maps HTTP %i to a friendly error", async (status, message) => {
  delete process.env.RBOX_DEBUG;
  expect((await friendlyHttpError(new Response("secret", { status }), "request")).message).toBe(message);
});

test("hides response bodies unless RBOX_DEBUG is set", async () => {
  delete process.env.RBOX_DEBUG;
  expect((await friendlyHttpError(new Response("sensitive", { status: 400 }), "request")).message).not.toContain("sensitive");
  process.env.RBOX_DEBUG = "1";
  expect((await friendlyHttpError(new Response("sensitive", { status: 400 }), "request")).message).toContain("\n  server said: sensitive");
});

test("uses and truncates an already-read response body in debug mode", async () => {
  process.env.RBOX_DEBUG = "1";
  const error = await friendlyHttpError(new Response(null, { status: 400 }), "request", "x".repeat(600));
  expect(error.message.split("server said: ")[1]).toHaveLength(500);
});
