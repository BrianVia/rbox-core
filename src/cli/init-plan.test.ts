import { test, expect } from "bun:test";
import {
  resolveInitPlan,
  resolveWorkspaceDeviceId,
  isInitError,
  collapseHome,
  sanitizeWorkspaceName,
  interpretWorkspaceNameAnswer,
  MAX_WORKSPACE_NAME,
  type InitInput,
  type CredsView,
} from "./init-plan.js";

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
  expect(r.respectGitignore).toBe(false);
});

test("--workspace <id> → join, firstSync sync (pull-first, not blind push)", () => {
  const r = resolveInitPlan(input({ flags: { workspace: "ws_abc", project: "api" } }));
  if (isInitError(r)) throw new Error("unexpected error");
  expect(r.workspace).toEqual({ kind: "join", id: "ws_abc", project: "api" });
  expect(r.firstSync).toBe("sync");
});

test("--respect-gitignore opts a new workspace into design-72 file filtering", () => {
  const r = resolveInitPlan(input({ flags: { "respect-gitignore": "true" } }));
  if (isInitError(r)) throw new Error("unexpected error");
  expect(r.respectGitignore).toBe(true);
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

// ── opt-in workspace name (server-visible dashboard label) ─────────────────

test("no --name → new workspace carries NO name (private, zero-knowledge default)", () => {
  const r = resolveInitPlan(input());
  if (isInitError(r)) throw new Error("unexpected error");
  expect(r.workspace).toEqual({ kind: "new", project: "root" });
  expect((r.workspace as { name?: string }).name).toBeUndefined();
});

test("--name on create → sanitized name threaded onto the new choice", () => {
  const r = resolveInitPlan(input({ flags: { name: "  Conductor workspaces  " } }));
  if (isInitError(r)) throw new Error("unexpected error");
  expect(r.workspace).toEqual({ kind: "new", project: "root", name: "Conductor workspaces" });
});

test("--name with only control chars/whitespace → treated as no name (skip)", () => {
  const r = resolveInitPlan(input({ flags: { name: "  \t\n  " } }));
  if (isInitError(r)) throw new Error("unexpected error");
  expect((r.workspace as { name?: string }).name).toBeUndefined();
});

test("--name on a join is a LOCAL cache label (threaded through, never sent to the server)", () => {
  // The picker passes the selected workspace's server name so init can cache it into
  // WorkspaceConfig for `rbox status` — it's display-only, and createRemoteWorkspace
  // (the sole name-writing call) is never invoked on a join.
  const r = resolveInitPlan(input({ flags: { workspace: "ws_abc", name: "  savvy-core  " } }));
  if (isInitError(r)) throw new Error("unexpected error");
  expect(r.workspace).toEqual({ kind: "join", id: "ws_abc", project: "root", name: "savvy-core" });
});

test("no --name on a join → no cached label (status falls back to the id)", () => {
  const r = resolveInitPlan(input({ flags: { workspace: "ws_abc" } }));
  if (isInitError(r)) throw new Error("unexpected error");
  expect(r.workspace).toEqual({ kind: "join", id: "ws_abc", project: "root" });
  expect((r.workspace as { name?: string }).name).toBeUndefined();
});

test("sanitizeWorkspaceName: strips control chars/newlines, trims, bounds length", () => {
  expect(sanitizeWorkspaceName(undefined)).toBeUndefined();
  expect(sanitizeWorkspaceName("")).toBeUndefined();
  expect(sanitizeWorkspaceName("   ")).toBeUndefined();
  expect(sanitizeWorkspaceName("~/code/rbox")).toBe("~/code/rbox");
  // newlines/tabs/other control chars are removed so it stays a single label line
  expect(sanitizeWorkspaceName("line1\nline2\tend")).toBe("line1line2end");
  const long = "x".repeat(MAX_WORKSPACE_NAME + 50);
  expect(sanitizeWorkspaceName(long)!.length).toBe(MAX_WORKSPACE_NAME);
});

// The single optional name input's answer interpretation: "-" is the discoverable
// skip sentinel (the retired confirm's "n" path — names are server-visible plaintext,
// so declining must stay first-class). ONLY the lone dash skips; dashes inside a name
// must never be treated as a skip.
test("interpretWorkspaceNameAnswer: lone dash and blank skip; anything else is the trimmed name", () => {
  expect(interpretWorkspaceNameAnswer("-")).toBeUndefined();
  expect(interpretWorkspaceNameAnswer("  -  ")).toBeUndefined(); // whitespace-padded dash still skips
  expect(interpretWorkspaceNameAnswer("")).toBeUndefined();
  expect(interpretWorkspaceNameAnswer("   ")).toBeUndefined();
  expect(interpretWorkspaceNameAnswer("my-app")).toBe("my-app"); // dash INSIDE a name is a name
  expect(interpretWorkspaceNameAnswer("  ~/code/rbox  ")).toBe("~/code/rbox");
  expect(interpretWorkspaceNameAnswer("--")).toBe("--"); // only exactly "-" skips
});

test("collapseHome: collapses the home prefix to ~, leaves outside paths untouched", () => {
  expect(collapseHome("/Users/via/conductor/workspaces", "/Users/via")).toBe("~/conductor/workspaces");
  expect(collapseHome("/Users/via", "/Users/via")).toBe("~");
  expect(collapseHome("/Users/via", "/Users/via/")).toBe("~"); // trailing slash on home
  expect(collapseHome("/etc/hosts", "/Users/via")).toBe("/etc/hosts");
  expect(collapseHome("/Users/viacom/x", "/Users/via")).toBe("/Users/viacom/x"); // no false prefix match
  expect(collapseHome("/any/path", "")).toBe("/any/path"); // no home known
});

// ── device-id unification ──────────────────────────────────────

test("workspace device id precedence", () => {
  let mints = 0;
  const mint = () => `dev_mint${++mints}`;
  expect(resolveWorkspaceDeviceId({ forceNew: true, override: "dev_override", prevDeviceId: "dev_prev", enrolledDeviceId: "dev_enrolled", credsDeviceId: "dev_creds", mint })).toBe("dev_mint1");
  expect(resolveWorkspaceDeviceId({ override: "dev_override", prevDeviceId: "dev_prev", enrolledDeviceId: "dev_enrolled", credsDeviceId: "dev_creds", mint })).toBe("dev_override");
  expect(resolveWorkspaceDeviceId({ prevDeviceId: "dev_prev", enrolledDeviceId: "dev_enrolled", credsDeviceId: "dev_creds", mint })).toBe("dev_enrolled");
  expect(resolveWorkspaceDeviceId({ prevDeviceId: "dev_prev", credsDeviceId: "dev_creds", mint })).toBe("dev_prev");
  expect(resolveWorkspaceDeviceId({ credsDeviceId: "dev_creds", mint })).toBe("dev_creds");
  expect(resolveWorkspaceDeviceId({ credsDeviceId: "env", mint })).toBe("dev_mint2");
});

test("two workspaces reuse the same enrolled device with RBOX_TOKEN credentials", () => {
  const resolve = () => resolveWorkspaceDeviceId({ enrolledDeviceId: "dev_machine", credsDeviceId: "env", mint: () => "dev_unused" });
  expect(resolve()).toBe("dev_machine");
  expect(resolve()).toBe("dev_machine");
});
