import { test, expect } from "bun:test";
import { resolveInitPlan, isInitError, unifyDeviceId, type InitInput, type CredsView } from "./init-plan.js";

const REMOTE = "https://example.invalid";
const creds = (over: Partial<CredsView> = {}): CredsView => ({ deviceId: "dev_server1", remoteUrl: REMOTE, ...over });

function input(over: Partial<InitInput> = {}): InitInput {
  return { flags: {}, cwd: "/work/proj", creds: creds(), interactive: true, defaultRemote: REMOTE, ...over };
}

// ── auth contract (the CI-safety core) ─────────────────────────────────────

test("no creds + non-interactive → auth_required error (never hangs CI)", () => {
  const r = resolveInitPlan(input({ creds: undefined, interactive: false }));
  expect(isInitError(r)).toBe(true);
  if (isInitError(r)) {
    expect(r.code).toBe("auth_required");
    expect(r.headlessHint).toContain("RBOX_TOKEN");
  }
});

test("no creds + interactive → plan defers to device login (no error)", () => {
  const r = resolveInitPlan(input({ creds: undefined, interactive: true }));
  expect(isInitError(r)).toBe(false);
  if (!isInitError(r)) expect(r.auth).toBe("need-interactive-login");
});

test("no creds + --bootstrap → headless bootstrap-login (works in CI, no error)", () => {
  const r = resolveInitPlan(input({ creds: undefined, interactive: false, flags: { bootstrap: "s3cret" } }));
  expect(isInitError(r)).toBe(false);
  if (!isInitError(r)) expect(r.auth).toBe("bootstrap-login");
});

test("creds present → auth:have regardless of interactivity", () => {
  for (const interactive of [true, false]) {
    const r = resolveInitPlan(input({ interactive }));
    expect(isInitError(r)).toBe(false);
    if (!isInitError(r)) expect(r.auth).toBe("have");
  }
});

// ── workspace + first-sync semantics ───────────────────────────────────────

test("default (no flags) → new workspace, firstSync push", () => {
  const r = resolveInitPlan(input());
  if (isInitError(r)) throw new Error("unexpected error");
  expect(r.workspace).toEqual({ kind: "new", project: "root" });
  expect(r.firstSync).toBe("push");
});

test("--workspace <id> → join, firstSync sync (pull-first, not blind push)", () => {
  const r = resolveInitPlan(input({ flags: { workspace: "ws_abc", project: "api" } }));
  if (isInitError(r)) throw new Error("unexpected error");
  expect(r.workspace).toEqual({ kind: "join", id: "ws_abc", project: "api" });
  expect(r.firstSync).toBe("sync");
});

test("--no-sync overrides firstSync to none for both new and join", () => {
  const asNew = resolveInitPlan(input({ flags: { "no-sync": "true" } }));
  const asJoin = resolveInitPlan(input({ flags: { workspace: "ws_x", "no-sync": "true" } }));
  if (isInitError(asNew) || isInitError(asJoin)) throw new Error("unexpected error");
  expect(asNew.firstSync).toBe("none");
  expect(asJoin.firstSync).toBe("none");
});

test("--new and --workspace together → conflicting_workspace error", () => {
  const r = resolveInitPlan(input({ flags: { new: "true", workspace: "ws_x" } }));
  expect(isInitError(r)).toBe(true);
  if (isInitError(r)) expect(r.code).toBe("conflicting_workspace");
});

// ── root + remote resolution ───────────────────────────────────────────────

test("--root is resolved to absolute; default is cwd", () => {
  const def = resolveInitPlan(input());
  const rel = resolveInitPlan(input({ flags: { root: "sub/dir" } }));
  if (isInitError(def) || isInitError(rel)) throw new Error("unexpected error");
  expect(def.root).toBe("/work/proj");
  expect(rel.root).toBe("/work/proj/sub/dir");
});

test("remote precedence: --remote > creds.remoteUrl > defaultRemote", () => {
  const flagWin = resolveInitPlan(input({ flags: { remote: "https://flag.invalid" } }));
  const credWin = resolveInitPlan(input({ creds: creds({ remoteUrl: "https://creds.invalid" }) }));
  const fallback = resolveInitPlan(input({ creds: undefined, interactive: true, defaultRemote: "https://default.invalid" }));
  if (isInitError(flagWin) || isInitError(credWin) || isInitError(fallback)) throw new Error("unexpected error");
  expect(flagWin.remoteUrl).toBe("https://flag.invalid");
  expect(credWin.remoteUrl).toBe("https://creds.invalid");
  expect(fallback.remoteUrl).toBe("https://default.invalid");
});

// ── device-id unification (review #9) ──────────────────────────────────────

test("device id unifies to the server-issued credential id", () => {
  expect(unifyDeviceId(creds({ deviceId: "dev_server1" }))).toEqual({ kind: "fixed", id: "dev_server1" });
});

test("RBOX_TOKEN env-placeholder ('env') and no creds → from-credentials (executor resolves)", () => {
  expect(unifyDeviceId(creds({ deviceId: "env" }))).toEqual({ kind: "from-credentials" });
  expect(unifyDeviceId(undefined)).toEqual({ kind: "from-credentials" });
});
