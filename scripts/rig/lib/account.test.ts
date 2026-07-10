import { test, expect } from "bun:test";
import {
  candidateRoots,
  grantProPlan,
  parseSecretFile,
  redactSecret,
  resolveBootstrapSecret,
  resolvePlatformSecret,
  readCredentials,
} from "./account.js";

test("parseSecretFile extracts the keyed value, tolerating quotes/comments/blank lines", () => {
  const content = ["# dev keys", "", 'RBOX_DEV_BOOTSTRAP_SECRET=dev-abc123', "OTHER=x"].join("\n");
  expect(parseSecretFile(content, "RBOX_DEV_BOOTSTRAP_SECRET")).toBe("dev-abc123");
  expect(parseSecretFile('RBOX_DEV_BOOTSTRAP_SECRET="q u o t e d"', "RBOX_DEV_BOOTSTRAP_SECRET")).toBe("q u o t e d");
  expect(parseSecretFile("NOPE=1", "RBOX_DEV_BOOTSTRAP_SECRET")).toBeUndefined();
});

test("candidateRoots probes the primary checkout when given a worktree path", () => {
  const primary = "/Users/x/dev/rbox-core";
  const worktree = `${primary}/.claude/worktrees/rig-p0`;
  expect(candidateRoots(worktree)).toEqual([worktree, primary]);
  // A normal checkout yields just itself.
  expect(candidateRoots(primary)).toEqual([primary]);
});

test("resolveBootstrapSecret precedence: env wins, then file (worktree → primary fallback)", () => {
  const primary = "/repo";
  const worktree = `${primary}/.claude/worktrees/rig-p0`;
  const files: Record<string, string> = { [`${primary}/dev-keys.local.secret`]: "RBOX_DEV_BOOTSTRAP_SECRET=from-file" };
  const readFile = (p: string) => files[p];

  // env wins outright
  expect(resolveBootstrapSecret(worktree, { env: { RBOX_DEV_BOOTSTRAP: "from-env" }, readFile })).toBe("from-env");
  // worktree has no file of its own → primary checkout fallback
  expect(resolveBootstrapSecret(worktree, { env: {}, readFile })).toBe("from-file");
  // no env, no file → hard error naming both options
  expect(() => resolveBootstrapSecret("/nowhere", { env: {}, readFile: () => undefined })).toThrow(/RBOX_DEV_BOOTSTRAP/);
});

test("resolvePlatformSecret uses RBOX_DEV_PLATFORM_SECRET from env, then the repo secret file", () => {
  const primary = "/repo";
  const worktree = `${primary}/.claude/worktrees/rig-p0`;
  const files: Record<string, string> = { [`${primary}/dev-keys.local.secret`]: "RBOX_DEV_PLATFORM_SECRET=from-file" };
  const readFile = (p: string) => files[p];

  expect(resolvePlatformSecret(worktree, { env: { RBOX_DEV_PLATFORM_SECRET: "from-env" }, readFile })).toBe("from-env");
  expect(resolvePlatformSecret(worktree, { env: {}, readFile })).toBe("from-file");
  expect(() => resolvePlatformSecret("/nowhere", { env: {}, readFile: () => undefined })).toThrow(/RBOX_DEV_PLATFORM_SECRET/);
});

test("grantProPlan posts the encoded account id with the platform header", async () => {
  let request: { input: string | URL | Request; init?: RequestInit } | undefined;
  const result = await grantProPlan("https://rbox-dev-api.example.test/", "acct/one", "platform-secret", async (input, init) => {
    request = { input, init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  expect(String(request?.input)).toBe("https://rbox-dev-api.example.test/v1/admin/account/acct%2Fone/plan?plan=pro");
  expect(request?.init).toEqual({ method: "POST", headers: { "x-rbox-platform": "platform-secret" } });
  expect(result).toEqual({ ok: true, status: 200, body: '{"ok":true}' });
});

test("grantProPlan refuses production before fetching", async () => {
  let fetched = false;
  await expect(
    grantProPlan("https://api.rbox.to", "acct_1", "platform-secret", async () => {
      fetched = true;
      return new Response(null, { status: 200 });
    })
  ).rejects.toThrow(/production/i);
  expect(fetched).toBe(false);
});

test("redactSecret masks the secret substring", () => {
  expect(redactSecret("login --bootstrap s3cr3t --remote x", "s3cr3t")).toBe("login --bootstrap *** --remote x");
  expect(redactSecret("no secret here", undefined)).toBe("no secret here");
});

test("readCredentials pulls token + accountId and rejects a tokenless file", () => {
  expect(readCredentials(JSON.stringify({ token: "t", accountId: "acct_1", deviceId: "d" }))).toEqual({ token: "t", accountId: "acct_1", deviceId: "d" });
  expect(() => readCredentials(JSON.stringify({ accountId: "acct_1" }))).toThrow(/token/);
});
