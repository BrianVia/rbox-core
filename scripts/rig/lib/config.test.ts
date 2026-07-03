import { test, expect } from "bun:test";
import { assertNotProd, DEFAULT_DEV_API, imageHash, resolveApiUrl } from "./config.js";

test("assertNotProd refuses the prod API host in every disguise", () => {
  for (const url of [
    "https://api.rbox.to",
    "https://api.rbox.to:443",
    "http://api.rbox.to",
    "https://api.rbox.to/v1/account",
    "https://API.RBOX.TO", // case-folded host still matches
    "https://rbox-prod-api.brian-via.workers.dev",
    "https://rbox-prod-api.x.workers.dev:8443/health",
  ]) {
    expect(() => assertNotProd(url)).toThrow(/production/i);
  }
});

test("assertNotProd allows dev + local URLs", () => {
  for (const url of [DEFAULT_DEV_API, "https://rbox-dev-api.brian-via.workers.dev", "http://localhost:8787", "http://host.container.internal:8787"]) {
    expect(() => assertNotProd(url)).not.toThrow();
  }
});

test("assertNotProd allows a non-prod host that merely embeds the prod string in userinfo/subpath", () => {
  // hostname is evil.example / other-host — the real connect host, never prod.
  expect(() => assertNotProd("https://api.rbox.to@evil.example/x")).not.toThrow();
  expect(() => assertNotProd("https://api.rbox.to.evil.example")).not.toThrow();
});

test("assertNotProd rejects a malformed URL", () => {
  expect(() => assertNotProd("not a url")).toThrow(/invalid/i);
});

test("resolveApiUrl precedence: flag > env > default", () => {
  const dev = "https://rbox-dev-api.brian-via.workers.dev";
  expect(resolveApiUrl({}, {})).toBe(DEFAULT_DEV_API);
  expect(resolveApiUrl({ RBOX_API: dev }, {})).toBe(dev);
  expect(resolveApiUrl({ RBOX_API: dev }, { "api-url": "http://localhost:8787" })).toBe("http://localhost:8787");
});

test("resolveApiUrl aborts when a prod URL lurks in RBOX_API even if a flag would dodge it", () => {
  expect(() => resolveApiUrl({ RBOX_API: "https://api.rbox.to" }, { "api-url": "http://localhost:8787" })).toThrow(/production/i);
});

test("imageHash is stable for equal inputs and changes when any input changes", () => {
  const base = { packageJson: "a", lockfile: "b", dockerfile: "c" };
  const h = imageHash(base);
  expect(imageHash(base)).toBe(h);
  expect(imageHash({ ...base, packageJson: "a2" })).not.toBe(h);
  expect(imageHash({ ...base, lockfile: "b2" })).not.toBe(h);
  expect(imageHash({ ...base, dockerfile: "c2" })).not.toBe(h);
  // Field boundaries can't collide (NUL-separated): moving a char across fields differs.
  expect(imageHash({ packageJson: "ab", lockfile: "", dockerfile: "c" })).not.toBe(imageHash({ packageJson: "a", lockfile: "b", dockerfile: "c" }));
});
