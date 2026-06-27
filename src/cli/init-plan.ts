/**
 * `rbox init` planning — PURE. No I/O, prompts, or network (design 07c §1).
 *
 * `resolveInitPlan` turns gathered inputs (flags, cwd, loaded credentials,
 * whether we're allowed to prompt) into either a concrete InitPlan or a precise
 * InitError. Both the interactive readline shell and a flag-only headless
 * invocation converge here, so the two paths can't diverge — and the whole
 * decision surface is unit-testable without a TTY or a server. A future OpenTUI
 * front-end drives the same function.
 */
import path from "node:path";

/** The per-machine credential shape we care about (subset of credentials.ts). */
export interface CredsView {
  deviceId: string;
  remoteUrl: string;
}

export interface InitInput {
  /** Parsed CLI flags (e.g. { new: "true", workspace: "ws_x", project, root, "no-sync": "true" }). */
  flags: Record<string, string>;
  cwd: string;
  /** Loaded credentials (env RBOX_TOKEN or ~/.rbox/credentials.json), if any. */
  creds: CredsView | undefined;
  /** May we prompt? = process.stdin.isTTY && !--no-interactive. */
  interactive: boolean;
  /** Fallback remote when no creds and no --remote. */
  defaultRemote: string;
}

export type WorkspaceChoice =
  | { kind: "new"; project: string }
  | { kind: "join"; id: string; project: string };

/** `from-credentials` = resolve from the credential saved by the login the
 *  executor will run (auth was "need-interactive-login"). */
export type ResolvedDeviceId = { kind: "fixed"; id: string } | { kind: "from-credentials" };

export interface InitPlan {
  /** have = creds already present; bootstrap-login = `--bootstrap <secret>` (works
   *  headless, e.g. first device in CI); need-interactive-login = TTY device-code flow. */
  auth: "have" | "bootstrap-login" | "need-interactive-login";
  workspace: WorkspaceChoice;
  root: string;
  remoteUrl: string;
  deviceId: ResolvedDeviceId;
  /** new→push (publish), join→sync (pull-first, surface conflicts), --no-sync→none. */
  firstSync: "push" | "sync" | "none";
}

export interface InitError {
  code: string;
  message: string;
  /** A copy-pasteable headless invocation that would succeed. */
  headlessHint: string;
}

export function isInitError(x: InitPlan | InitError): x is InitError {
  return (x as InitError).code !== undefined;
}

const TRUE = "true";

/**
 * The auth device id is the sync identity (design 07c §6). The `"env"`
 * placeholder is what credentials.ts assigns when RBOX_TOKEN is set without
 * RBOX_DEVICE_ID — not a real per-device id, so fall back to a generated one.
 */
export function unifyDeviceId(creds: CredsView | undefined): ResolvedDeviceId {
  if (!creds || creds.deviceId === "env") return { kind: "from-credentials" };
  return { kind: "fixed", id: creds.deviceId };
}

export function resolveInitPlan(input: InitInput): InitPlan | InitError {
  const { flags, cwd, creds, interactive } = input;

  // --new and --workspace are mutually exclusive.
  const joinId = flags.workspace;
  const wantNew = flags.new === TRUE;
  if (wantNew && joinId) {
    return {
      code: "conflicting_workspace",
      message: "--new and --workspace are mutually exclusive (create OR join, not both).",
      headlessHint: "rbox init --new   |   rbox init --workspace <id>",
    };
  }

  // Auth contract (design 07c §2): creds present → have; `--bootstrap <secret>`
  // → headless bootstrap login (e.g. first device in CI); else interactive →
  // device-code flow; else (non-interactive, no creds, no bootstrap) → hard
  // error (never start a device-code wait in CI).
  let auth: InitPlan["auth"];
  if (creds) {
    auth = "have";
  } else if (flags.bootstrap) {
    auth = "bootstrap-login";
  } else if (interactive) {
    auth = "need-interactive-login";
  } else {
    return {
      code: "auth_required",
      message: "not logged in and not interactive — cannot authenticate headlessly without a token.",
      headlessHint: "set RBOX_TOKEN=<device-token>, pass --bootstrap <secret>, or run `rbox login` once, then re-run.",
    };
  }

  const project = flags.project ?? "root";
  const workspace: WorkspaceChoice = joinId ? { kind: "join", id: joinId, project } : { kind: "new", project };

  // Resolve against the input cwd (NOT process.cwd) so the planner stays pure.
  const root = path.resolve(cwd, flags.root ?? cwd);
  const remoteUrl = flags.remote ?? creds?.remoteUrl ?? input.defaultRemote;

  // First-sync semantics (design 07c §3): publishing a brand-new workspace is a
  // push; joining an existing one must pull/reconcile first (never blind-upload
  // an arbitrary local tree over someone else's workspace).
  const firstSync: InitPlan["firstSync"] =
    flags["no-sync"] === TRUE ? "none" : workspace.kind === "new" ? "push" : "sync";

  return { auth, workspace, root, remoteUrl, deviceId: unifyDeviceId(creds), firstSync };
}
