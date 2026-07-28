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
import crypto from "node:crypto";
import path from "node:path";
import { parseScopeFlag, validateScopePrefixes } from "./scope/scope-record.js";

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
  | { kind: "new"; project: string; name?: string }
  // `name` on a JOIN is a purely-LOCAL display label (never sent to the server —
  // only `createRemoteWorkspace` carries a name, and that's the create path). The
  // picker ("track existing") passes the selected workspace's server name through
  // here so it can be cached into WorkspaceConfig for `rbox status`.
  | { kind: "join"; id: string; project: string; name?: string };

/** Max stored length of the OPT-IN, server-visible workspace name (mirrors the
 *  server bound in apps/api/src/authz.ts). It's a label, not a path. */
export const MAX_WORKSPACE_NAME = 128;

/** Collapse a leading home-dir prefix to `~` for the opt-in name's suggested
 *  default (drops the OS username; keeps the local structure the user opts to share).
 *  PURE — home is passed in (os.homedir() stays in the impure shell). */
export function collapseHome(p: string, home: string): string {
  if (!home) return p;
  const h = home.replace(/[/\\]+$/, "");
  if (p === h) return "~";
  if (p.startsWith(h + "/")) return "~" + p.slice(h.length);
  return p;
}

/** Sanitize the OPT-IN, server-visible workspace name: it's OPAQUE user text, so
 *  strip control chars/newlines (single label line), trim, and bound length. Empty/
 *  absent → undefined = no name (the private, zero-knowledge default). */
export function sanitizeWorkspaceName(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  // eslint-disable-next-line no-control-regex -- strip C0/C1 control chars (incl. \n\r\t)
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return cleaned ? cleaned.slice(0, MAX_WORKSPACE_NAME) : undefined;
}

/** Interpret the answer from the single optional workspace-name input. The prompt
 *  pre-fills a suggestion, so a bare ENTER accepts it; "-" is the DISCOVERABLE skip
 *  sentinel (the old confirm-step's "n" path — names are server-visible plaintext,
 *  so declining must stay a first-class, documented move). Exactly "-" after trim →
 *  no name; a dash INSIDE a name ("my-app") passes through untouched. */
export function interpretWorkspaceNameAnswer(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed && trimmed !== "-" ? trimmed : undefined;
}

export interface InitPlan {
  /** have = creds already present; bootstrap-login = `--bootstrap <secret>` (works
   *  headless, e.g. first device in CI); need-interactive-login = TTY device-code flow. */
  auth: "have" | "bootstrap-login" | "need-interactive-login";
  workspace: WorkspaceChoice;
  root: string;
  remoteUrl: string;
  /** new→push, join→sync, keyed agent join→pull, --no-sync→none. */
  firstSync: "push" | "sync" | "pull" | "none";
  /** §28: git-sync defaults ON (git artifacts are E2EE-encrypted); --git false opts out. */
  syncGit: boolean;
  /** Design 72 opt-in. Defaults false so new scripted workspaces keep current behavior. */
  respectGitignore: boolean;
  /** Design 212: sync only these workspace folders on this machine. Present ⇒ the
   *  binding is structurally receive-only. Absent = the whole workspace. */
  scope?: string[];
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

/** Resolve the device id to write into a workspace binding. Precedence:
 *  force-new, explicit override, enrolled identity, previous binding, real
 *  credential id, then a freshly minted id. The default `mint` is this module's
 *  only nondeterminism (crypto.randomUUID) — tests inject `mint` to pin it. */
export function resolveWorkspaceDeviceId(opts: {
  forceNew?: boolean;
  override?: string;
  prevDeviceId?: string;
  enrolledDeviceId?: string;
  credsDeviceId?: string;
  mint?: () => string;
}): string {
  const mint = opts.mint ?? (() => `dev_${crypto.randomUUID().slice(0, 8)}`);
  if (opts.forceNew) return mint();
  return (
    opts.override ??
    opts.enrolledDeviceId ??
    opts.prevDeviceId ??
    (opts.credsDeviceId && opts.credsDeviceId !== "env" ? opts.credsDeviceId : undefined) ??
    mint()
  );
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
  // Opt-in, server-visible name — only meaningful when CREATING (the single INSERT is
  // first-writer-wins). Absent/blank → no name = the private, zero-knowledge default.
  // `project_id` is a SEPARATE PK field and stays "root"; this is just a dashboard label.
  const name = sanitizeWorkspaceName(flags.name);
  const workspace: WorkspaceChoice = joinId
    ? { kind: "join", id: joinId, project, ...(name ? { name } : {}) }
    : { kind: "new", project, ...(name ? { name } : {}) };

  // Resolve against the input cwd (NOT process.cwd) so the planner stays pure.
  const root = path.resolve(cwd, flags.root ?? cwd);
  const remoteUrl = flags.remote ?? creds?.remoteUrl ?? input.defaultRemote;

  // First-sync semantics (design 07c §3): publishing a brand-new workspace is a
  // push; joining an existing one must pull/reconcile first (never blind-upload
  // an arbitrary local tree over someone else's workspace).
  const firstSync: InitPlan["firstSync"] =
    flags["no-sync"] === TRUE ? "none" : workspace.kind === "new" ? "push" : flags["pull-only"] === TRUE ? "pull" : "sync";

  // Design 212 §2: a scoped binding must be pull-only. Publishing from a partial
  // tree would ask the differ to read every folder this machine does not have as
  // deleted, so the two flags are one decision, refused at bind time.
  let scope: string[] | undefined;
  if (flags.scope !== undefined) {
    if (firstSync !== "pull") {
      return {
        code: "scope_requires_pull_only",
        message: "syncing only some folders is one-way for now: add --pull-only.",
        headlessHint: `rbox init --workspace <id> --scope ${flags.scope} --pull-only`,
      };
    }
    const validated = validateScopePrefixes(parseScopeFlag(flags.scope));
    if (!validated.ok) {
      return { code: "invalid_scope", message: validated.error, headlessHint: "rbox init --workspace <id> --scope Personal/repo-A --pull-only" };
    }
    scope = validated.prefixes;
  }

  return {
    auth,
    workspace,
    root,
    remoteUrl,
    firstSync,
    syncGit: flags.git !== "false",
    respectGitignore: flags["respect-gitignore"] === "true",
    ...(scope === undefined ? {} : { scope }),
  };
}
