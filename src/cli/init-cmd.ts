/**
 * `rbox init` — the impure shell over the pure planner (design 07c §1, §7).
 *
 * Responsibilities: gather inputs (prompting on stderr ONLY when interactive),
 * hand them to `resolveInitPlan`, and execute the resulting plan by orchestrating
 * existing primitives (login, createRemoteWorkspace, config write, first sync).
 * All decision logic lives in init-plan.ts; this file is presentation + I/O.
 */
import os from "node:os";
import path from "node:path";
import { credentialsForStrictFlow, loadCredentials, type CredentialLoadResult, type Credentials } from "./credentials.js";
import { createRemoteWorkspace } from "./remote.js";
import { loadConfig, loadConfigIfPresent, loadRawState, resetSyncState, saveConfig, syncStreamId, type WorkspaceConfig } from "./config.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { enrolledDeviceId, hasDevice } from "./e2ee-keystore.js";
import { login } from "./auth-cmd.js";
import { filesFirstFlagEnabled, pull, push, sync } from "./sync.js";
import { beginReport, logDebugSummary } from "./metrics.js";
import { resolveInitPlan, resolveWorkspaceDeviceId, isInitError, collapseHome, interpretWorkspaceNameAnswer, type InitPlan } from "./init-plan.js";
import { style, stderrStyle, fail } from "./style.js";
import { spinner } from "./spinner.js";
import { progressLabel } from "./status-view.js";
import { promptSelect, promptInput, promptPath } from "./prompt.js";
import { promptWorkspacePick } from "./workspace-picker.js";
import { recoveryKitOptionsFromFlags, type RecoveryKitOptions } from "./recovery-kit.js";
import { createPopulateStatusWriter } from "./populate-status.js";
import type { GitPushPlan } from "./sync-git.js";
import { acquireWorkspaceSyncMutex, assertSyncMutex, releaseWorkspaceSyncMutex, type WorkspaceSyncMutex } from "./sync-mutex.js";
import {
  RebindConsentRequiredError,
  createWorkspaceWithConsent,
  inspectResetConsentIntent,
  type ResetConsentWitness,
} from "./reset-consent.js";

export const WORKSPACE_DEFINITION =
  "a workspace can be a single repository or a folder of many repositories, or just a folder.";

const INTERACTIVE_GIT_LIST_LIMIT = 5;

/** Init-only presentation of the structured git plan. The forensic formatter remains
 * a full, single log line for daemon and other grep-oriented sinks. */
export function formatInteractiveGitPushSummary(plan: GitPushPlan): string {
  const oneLine = (value: string) => value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
  const bullets = (items: readonly string[]) => {
    const shown = items.slice(0, INTERACTIVE_GIT_LIST_LIMIT).map((item) => `    • ${oneLine(item)}`);
    if (items.length > INTERACTIVE_GIT_LIST_LIMIT) shown.push(`    …and ${items.length - INTERACTIVE_GIT_LIST_LIMIT} more`);
    return shown;
  };
  const lines = [
    `git-sync: captured ${plan.captured.length} · carried ${plan.carried.length} · skipped ${plan.skipped.length} · deferred ${plan.deferred.length} · removed ${plan.removed.length}`,
  ];
  if (plan.captured.length) lines.push("  captured:", ...bullets(plan.captured));
  if (plan.skipped.length) {
    lines.push(
      "  skipped:",
      ...bullets(plan.skipped.map(({ relPath, reason }) => `${relPath} — ${reason}`)),
    );
  }
  return lines.join("\n");
}

/** Founder-specified init label; progressLabel supplies terminal-safe repo detail. */
export function attachingGitHistoryLabel(done: number, total: number, detail?: string): string {
  const generic = progressLabel("gitcap", done, total, detail);
  return `attaching git history (${generic.slice("capturing git state ".length)})`;
}

/**
 * Gather the missing init inputs interactively (all widgets render on stderr, so
 * `rbox init > out.txt` never pollutes stdout). Callers gate this on a TTY —
 * inquirer requires one. `ctx` carries the creds/remote the join picker needs.
 */
export async function promptMissing(
  flags: Record<string, string>,
  cwd: string,
  ctx: {
    creds: Credentials | undefined;
    defaultRemote: string;
    promptPath?: typeof promptPath;
    promptSelect?: typeof promptSelect;
    promptInput?: typeof promptInput;
    promptWorkspacePick?: typeof promptWorkspacePick;
  }
): Promise<Record<string, string>> {
  const next = { ...flags };
  const select = ctx.promptSelect ?? promptSelect;
  const input = ctx.promptInput ?? promptInput;
  const pickWorkspace = ctx.promptWorkspacePick ?? promptWorkspacePick;
  if (next.new !== "true" && !next.workspace) {
    process.stderr.write(
      `${stderrStyle.dim(WORKSPACE_DEFINITION)}\n`
    );
    const choice = await select<"new" | "join">({
      message: "New workspace, or join an existing one?",
      choices: [
        { name: "Create a new workspace", value: "new" },
        { name: "Join an existing workspace", value: "join", description: "pick one you've already synced" },
      ],
    });
    if (choice === "join") {
      // Pick by name (degrades to a manual id prompt offline / no creds / empty).
      const picked = await pickWorkspace({ baseUrl: ctx.creds?.remoteUrl ?? ctx.defaultRemote, token: ctx.creds?.token, mode: "legacy" });
      // Backing out of the picker (blank manual entry) falls through as a NEW
      // workspace — mirrors the old "[new]" default when nothing was entered.
      if (picked) {
        next.workspace = picked.workspaceId;
        // Cache the picked name locally so `rbox status` shows it (manual entry has none).
        if (picked.name) next.name = picked.name;
      }
    }
  }
  if (!next.root) {
    next.root = await (ctx.promptPath ?? promptPath)({ message: "Sync which directory?", default: cwd, cwd });
  }
  // Workspace name — offered on a TTY only when CREATING. `--name` is the scripted
  // opt-in and, when present (next.name != null), skips this whole block. Skipped
  // when JOINING (`--workspace <id>`): the row already exists, so a name here would
  // never be stored. A name is OPTIONAL — declining the confirm keeps it private
  // (the label is server-side / NOT end-to-end encrypted, so skippability matters).
  if (!next.workspace && next.name == null) {
    const resolvedRoot = path.resolve(cwd, next.root ?? cwd);
    const suggestion = collapseHome(resolvedRoot, os.homedir());
    process.stderr.write(
      `${stderrStyle.dim("a workspace name is OPTIONAL and shown in the web dashboard (visible to rbox, server-side — NOT end-to-end encrypted).")}\n`
    );
    // Single optional input: the suggestion is the default, so a bare ENTER names the
    // workspace by its directory (what the old confirm→input two-step did on default+
    // ENTER); "-" is the documented skip (the old confirm's "n" path — keeps it private).
    const ans = interpretWorkspaceNameAnswer(await input({ message: `Workspace name (Enter accepts, "-" for none)`, default: suggestion }));
    if (ans) next.name = ans;
  }
  if (!next.workspace && next["respect-gitignore"] == null) {
    next["respect-gitignore"] = await select<"false" | "true">({
      message: "How should rbox handle gitignored files?",
      choices: GITIGNORE_CHOICES,
    });
  }
  return next;
}

export const GITIGNORE_CHOICES = [
  {
    name: "Skip gitignored untracked files (recommended)",
    value: "true",
    description: "sync a secrets file anyway (encrypted, never committed) with ! lines in .rboxignore — e.g. !.env or !.dev.vars; switch later with `rbox ignore --respect-gitignore off`",
  },
  {
    name: "Sync gitignored files too (end-to-end encrypted)",
    value: "false",
    description: "relaxes nested .gitignore rules only — your root .gitignore and built-ins (node_modules, .env, …) still apply; re-include secrets with ! lines in .rboxignore (e.g. !.env)",
  },
] as const;

/** What an executed init produced — returned so callers like `setup` can print a
 *  unified summary (with `summary: false`) instead of init's own trailing block. */
export interface InitOutcome {
  workspaceId: string;
  workspaceName?: string;
  deviceId: string;
  root: string;
}

export const GUIDED_GENESIS_PULL_NOTICE = "nothing was available to pull — this workspace had no prior snapshot";

export function guidedGenesisPullNotice(guidedSetup: boolean, initialRemoteSequence: number): string | undefined {
  return guidedSetup && initialRemoteSequence === 0 ? GUIDED_GENESIS_PULL_NOTICE : undefined;
}

export function writeGuidedGenesisPullNotice(
  guidedSetup: boolean,
  initialRemoteSequence: number,
  writeStderr: (text: string) => void = (text) => process.stderr.write(text)
): void {
  const notice = guidedGenesisPullNotice(guidedSetup, initialRemoteSequence);
  if (notice) writeStderr(`${stderrStyle.dim(notice)}\n`);
}

export async function runInit(
  flags: Record<string, string>,
  opts: {
    cwd: string;
    defaultRemote: string;
    summary?: boolean;
    guidedSetup?: boolean;
    resetConsent?: ResetConsentWitness;
    credentialResult?: CredentialLoadResult;
  }
): Promise<InitOutcome | undefined> {
  const credentialResult = opts.credentialResult ?? await loadCredentials();
  const creds = credentialsForStrictFlow(credentialResult);
  const interactive = process.stdin.isTTY === true && flags["no-interactive"] !== "true";

  let gathered = flags;
  if (interactive) gathered = await promptMissing(flags, opts.cwd, { creds, defaultRemote: opts.defaultRemote });

  const plan = resolveInitPlan({ flags: gathered, cwd: opts.cwd, creds, interactive, defaultRemote: opts.defaultRemote });
  if (isInitError(plan)) {
    fail(plan.message);
    process.stderr.write(`${stderrStyle.dim("try:")} ${plan.headlessHint}\n`);
    process.exitCode = 1;
    return undefined;
  }
  await preflightInitRebind(plan, opts.resetConsent);
  return executeInitPlan(plan, gathered.bootstrap, {
    summary: opts.summary !== false,
    recoveryKit: recoveryKitOptionsFromFlags(gathered),
    newDevice: gathered["new-device"] === "true",
    guidedSetup: opts.guidedSetup === true,
    resetConsent: opts.resetConsent,
    credentialResult,
  });
}

/**
 * Refuse direct/scripted init rebinds before login, workspace creation, mutex
 * acquisition, or local writes. Setup is the sole caller that supplies a
 * witness minted by its consequence prompt.
 */
export async function preflightInitRebind(
  plan: Pick<InitPlan, "root" | "remoteUrl" | "workspace">,
  consent?: ResetConsentWitness,
): Promise<void> {
  const prev = await loadConfig(plan.root).catch(() => undefined);
  const raw = await loadRawState(plan.root);
  const oldStream = raw?.stream ?? (prev ? syncStreamId(prev) : undefined);
  if (!oldStream) return;
  const nextKnown = plan.workspace.kind === "join"
    ? syncStreamId({ remoteUrl: plan.remoteUrl, remoteWorkspaceId: plan.workspace.id, projectId: plan.workspace.project })
    : undefined;
  if (nextKnown === oldStream) return;
  if (!consent) throw new RebindConsentRequiredError(plan.root);

  const inspected = inspectResetConsentIntent(consent);
  const observedOldNonce = raw?.stateNonce;
  const observedRevision = Number.isSafeInteger(raw?.stateRevision) ? raw!.stateRevision! : 0;
  const intentMatches = plan.workspace.kind === "new"
    ? inspected.intent.kind === "create"
      && inspected.intent.remoteUrl === plan.remoteUrl
      && inspected.intent.projectId === plan.workspace.project
    : inspected.intent.kind === "existing"
      && inspected.intent.remoteUrl === plan.remoteUrl
      && inspected.intent.workspaceId === plan.workspace.id
      && inspected.intent.projectId === plan.workspace.project;
  if (inspected.root !== path.resolve(plan.root)
    || inspected.observedOldStream !== oldStream
    || inspected.observedOldNonce !== observedOldNonce
    || inspected.mintedAtRevision !== observedRevision
    || !intentMatches) {
    throw new RebindConsentRequiredError(plan.root);
  }
}

export function initRebindNeedsReset(
  previousStream: string | undefined,
  activeStream: string | undefined,
  nextStream: string,
): boolean {
  return activeStream !== undefined
    ? activeStream !== nextStream
    : previousStream !== undefined && previousStream !== nextStream;
}

export interface PrecreatedWorkspaceContinuation {
  workspaceId: string;
  syncMutex: WorkspaceSyncMutex;
  resetConsent?: ResetConsentWitness;
}

interface PrecreatedContinuationDeps {
  loadCredentials?: typeof loadCredentials;
  releaseMutex?: typeof releaseWorkspaceSyncMutex;
  executePlan?: typeof executeInitPlan;
}

/** Adopt setup's precreated workspace id + held mutex; never mints or acquires. */
export function adoptPrecreatedWorkspaceResources(
  plan: InitPlan,
  continuation: PrecreatedWorkspaceContinuation
): { workspaceId: string; syncMutex: WorkspaceSyncMutex; ownsSyncMutex: boolean } {
  if (plan.workspace.kind !== "new") throw new Error("precreated workspace continuation requires a new-workspace plan");
  assertSyncMutex(continuation.syncMutex, plan.root);
  return { workspaceId: continuation.workspaceId, syncMutex: continuation.syncMutex, ownsSyncMutex: false };
}

/**
 * Continue a genuinely-new init using setup's already-minted id and held mutex.
 * Calling this function transfers mutex ownership; its outer finally releases it
 * exactly once, including invalid-plan, root-mismatch, success, and failure exits.
 */
export async function continueInitWithPrecreatedWorkspace(
  flags: Record<string, string>,
  opts: { cwd: string; defaultRemote: string; summary?: boolean; guidedSetup?: boolean },
  continuation: PrecreatedWorkspaceContinuation,
  deps: PrecreatedContinuationDeps = {}
): Promise<InitOutcome | undefined> {
  try {
    const credentialResult = await (deps.loadCredentials ?? loadCredentials)();
    const creds = credentialsForStrictFlow(credentialResult);
    const plan = resolveInitPlan({ flags, cwd: opts.cwd, creds, interactive: false, defaultRemote: opts.defaultRemote });
    if (isInitError(plan)) {
      fail(plan.message);
      process.stderr.write(`${stderrStyle.dim("try:")} ${plan.headlessHint}\n`);
      process.exitCode = 1;
      return undefined;
    }
    if (plan.workspace.kind !== "new") throw new Error("precreated workspace continuation requires a new-workspace plan");
    assertSyncMutex(continuation.syncMutex, plan.root);
    await preflightInitRebind(plan, continuation.resetConsent);
    return await (deps.executePlan ?? executeInitPlan)(
      plan,
      flags.bootstrap,
      {
        summary: opts.summary !== false,
        recoveryKit: recoveryKitOptionsFromFlags(flags),
        newDevice: flags["new-device"] === "true",
        guidedSetup: opts.guidedSetup === true,
        resetConsent: continuation.resetConsent,
        credentialResult,
      },
      continuation
    );
  } finally {
    await (deps.releaseMutex ?? releaseWorkspaceSyncMutex)(continuation.syncMutex);
  }
}

async function executeInitPlan(
  plan: InitPlan,
  bootstrapSecret: string | undefined,
  opts: {
    summary: boolean;
    recoveryKit: RecoveryKitOptions;
    newDevice: boolean;
    guidedSetup: boolean;
    resetConsent?: ResetConsentWitness;
    credentialResult?: CredentialLoadResult;
  },
  continuation?: PrecreatedWorkspaceContinuation
): Promise<InitOutcome | undefined> {
  // 1. Auth: bootstrap-login works headlessly (one-shot secret); device-code is
  //    interactive-only. "have" needs nothing. Never start device-code in CI.
  if (plan.auth === "bootstrap-login") {
    await login(plan.remoteUrl, bootstrapSecret, undefined, opts.recoveryKit);
  } else if (plan.auth === "need-interactive-login") {
    await login(plan.remoteUrl, undefined);
  }
  // "have" was authorized by the caller's typed observation. Login is the one
  // transition that intentionally replaces it by saving new credentials.
  const loadedCredentials = plan.auth === "have" && opts.credentialResult
    ? opts.credentialResult
    : await loadCredentials();
  const creds = credentialsForStrictFlow(loadedCredentials);
  if (!creds) {
    fail("login did not produce a credential — aborting init.");
    return undefined;
  }
  // 2. Workspace: create (new) or adopt the id (join — first sync validates access).
  let workspaceId: string;
  let syncMutex!: WorkspaceSyncMutex;
  let ownsSyncMutex = continuation === undefined;
  const ws = spinner(plan.workspace.kind === "new" ? "creating workspace" : "joining workspace");
  try {
    if (continuation) {
      ({ workspaceId, syncMutex, ownsSyncMutex } = adoptPrecreatedWorkspaceResources(plan, continuation));
    } else if (plan.workspace.kind === "new" && opts.resetConsent) {
      const created = await createWorkspaceWithConsent(
        opts.resetConsent,
        { remoteUrl: plan.remoteUrl, projectId: plan.workspace.project, name: plan.workspace.name },
        () => createRemoteWorkspace(plan.remoteUrl, creds.token, plan.workspace.project, plan.workspace.name),
      );
      workspaceId = created.workspaceId;
      opts.resetConsent = created.witness;
    } else {
      workspaceId = plan.workspace.kind === "new"
        ? await createRemoteWorkspace(plan.remoteUrl, creds.token, plan.workspace.project, plan.workspace.name)
        : plan.workspace.id;
    }
    ws.succeed(`workspace ${style.cyan(workspaceId)}`);
  } catch (e) {
    ws.fail("workspace setup failed");
    throw e;
  }

  // Init/setup owns one mutex across the complete rebind/reset + first-sync
  // decision, mutation, and state-save interval. Nested pull/push calls inherit it.
  if (!continuation) syncMutex = await acquireWorkspaceSyncMutex(plan.root, "cli");
  let deviceId!: string;
  try {
    // 3. Write the per-device binding (token injected at runtime, never persisted).
    //    REBIND (design 44): if this root was already bound to a DIFFERENT workspace,
    //    its sync baseline describes the OLD stream — reconciling the new one against
    //    it reads every old file as remotely deleted (the 2026-07-01 mass-delete
    //    incident). Reset the baseline explicitly (loadState also guards via the
    //    stream stamp; this keeps the on-disk state truthful) and say so.
    // Setup-create already made a typed rebind probe and needs later local faults to
    // surface as known-id continuation failures. Ordinary/scripted init preserves
    // its legacy best-effort probe semantics.
    const prev = continuation
      ? await loadConfigIfPresent(plan.root)
      : await loadConfig(plan.root).catch(() => undefined);
    deviceId = resolveWorkspaceDeviceId({
      forceNew: opts.newDevice,
      prevDeviceId: prev?.deviceId,
      enrolledDeviceId: await enrolledDeviceId(creds.accountId),
      credsDeviceId: creds.deviceId,
    });
    const nextStream = syncStreamId({ remoteUrl: plan.remoteUrl, remoteWorkspaceId: workspaceId, projectId: plan.workspace.project });
    const active = await loadRawState(plan.root);
    if (initRebindNeedsReset(prev ? syncStreamId(prev) : undefined, active?.stream, nextStream)) {
      await resetSyncState(plan.root, nextStream, syncMutex, opts.resetConsent);
      process.stderr.write(
        `${stderrStyle.yellow("!")} this directory ${prev ? `was bound to workspace ${prev.remoteWorkspaceId}` : "had sync history for another workspace"} — ` +
          `rebinding to ${workspaceId}. Local sync baseline reset; files on disk untouched.\n`
      );
    }
    const cfg: WorkspaceConfig = {
      schema: "e2ee/v1", // full end-to-end encryption (design 12) — the only mode
      remoteWorkspaceId: workspaceId,
      projectId: plan.workspace.project,
      deviceId,
      rootPath: plan.root,
      remoteUrl: plan.remoteUrl,
      token: "",
      // §28: git-sync defaults ON (git artifacts are E2EE-encrypted). No-ops on a non-git root;
      // pass --git false to opt out. This is the git-native sync the product is built around.
      syncGit: plan.syncGit,
      respectGitignore: plan.respectGitignore,
      // Cache the workspace name LOCALLY so `rbox status` shows it with no round-trip.
      // Present on CREATE (the name just typed) and on TRACK-EXISTING (the picked name).
      ...(plan.workspace.name ? { name: plan.workspace.name } : {}),
    };
    await saveConfig(plan.root, cfg);

    // 4. This workspace is end-to-end encrypted: the server stores only ciphertext.
    process.stderr.write(`${stderrStyle.dim("this workspace is end-to-end encrypted — the server never sees your file names or contents.")}\n`);

    // 5. First sync through the E2EE transport. Pre-check enrollment so a join via
    //    device-code (which authorizes but doesn't carry the key) gives clear
    //    guidance up front rather than failing mid-spinner.
    if (creds.accountId && !(await hasDevice(creds.accountId))) {
      fail("this machine isn't enrolled for encryption yet.");
      process.stderr.write(`${stderrStyle.dim("on a set-up machine run")} rbox pair${stderrStyle.dim(", then here:")} echo <token> | rbox connect${stderrStyle.dim(", then re-run init.")}\n`);
      process.exitCode = 1;
      return undefined;
    }
    const { cfg: authed, deps } = await buildAuthedRemote(plan.root, Date.now, undefined, loadedCredentials);
    deps.syncMutex = syncMutex;
    let pendingGitSummary: GitPushPlan | undefined;
    deps.onGitLog = (line, pushPlan) => {
      if (pushPlan) pendingGitSummary = pushPlan;
      else console.error(line);
    };
    const flushGitSummaries = () => {
      if (!pendingGitSummary) return;
      process.stderr.write(`${stderrStyle.green(formatInteractiveGitPushSummary(pendingGitSummary))}\n`);
      pendingGitSummary = undefined;
    };
    if (plan.firstSync === "push") {
      const sp = spinner("publishing initial snapshot — scanning files");
      try {
        let slowNotePhase: "encrypt" | "upload" | undefined;
        deps.onProgress = (done, total, phase, detail, bytes) => {
          sp.update(progressLabel(phase, done, total, detail, bytes));
          if (phase !== slowNotePhase && (phase === "encrypt" || phase === "upload")) {
            slowNotePhase = phase;
            sp.slowNote(
              phase === "encrypt"
                ? "initial encryption of many small files can take time"
                : "uploading many small files can take a while — this is normal"
            );
          }
        };
        // (design 108): the milestone + report wiring is FLAG-GATED — a flag-off init
        // must emit exactly the pre-108 output (no summary
        // line, no report-enabled commit path). Under the flag: the command-level
        // "files synced" milestone is captured BEFORE scan so timeToFilesSyncedMs
        // includes the scan wall, and a fresh enabled report renders FirstPublishStats.
        const filesFirst = filesFirstFlagEnabled();
        const report1 = filesFirst ? beginReport("push") : undefined;
        if (filesFirst) {
          deps.filesFirstStartedAt = performance.now();
          deps.report = report1;
        }
        // Commit 1 — files (git deferred under RBOX_FILES_FIRST on a genuine genesis;
        // otherwise an ordinary single git-first commit).
        const r1 = await push(plan.root, authed, deps);
        // Never report a publish that didn't happen (design 44): the incident setup
        // printed "published → sequence 75" for a push that uploaded zero bytes.
        sp.succeed(
          r1.committed
            ? `published ${style.sym.arrow} sequence ${style.cyan(String(r1.sequence))}`
            : `already in sync — nothing to upload ${style.dim(`(sequence ${r1.sequence})`)}`
        );
        flushGitSummaries();
        logDebugSummary(report1, (l) => console.log(style.dim(l)));

        // Commit 2 — attach git history (design 108 §3.1). CONDITIONAL: only when commit 1
        // was a files-only, sequence-advancing genesis commit with git still owed. A bypass
        // (no file diff) or starvation fallback already captured git → no second push. The
        // SAME held first-sync mutex (deps.syncMutex is unchanged) means no other process
        // interleaves; commit 1's "files synced ✓" stays true regardless of commit 2.
        if (r1.gitDeferred) {
          const sp2 = spinner("attaching git history");
          deps.filesFirstStartedAt = undefined; // commit 2 is not the files-synced milestone
          const report2 = beginReport("push");
          deps.report = report2;
          let attachedRepos = 0;
          deps.onProgress = (done, total, phase, detail, bytes) => {
            if (phase === "gitcap") {
              // Byte ticks use the completed count and can precede the first settle;
              // update only as repositories finish so the index stays truthful.
              if (done > attachedRepos) {
                attachedRepos = done;
                sp2.update(attachingGitHistoryLabel(done, total, detail));
              }
              return;
            }
            sp2.update(progressLabel(phase, done, total, detail, bytes));
          };
          try {
            const r2 = await push(plan.root, authed, deps);
            sp2.succeed(
              r2.committed
                ? `git history attached ${style.sym.arrow} sequence ${style.cyan(String(r2.sequence))}`
                : `git history up to date ${style.dim(`(sequence ${r2.sequence})`)}`
            );
            flushGitSummaries();
            logDebugSummary(report2, (l) => console.log(style.dim(l)));
          } catch {
            // Commit 1's files are durable; git resumes via the daemon or the next push.
            sp2.stop();
            process.stderr.write(`${stderrStyle.dim("Git history will continue uploading in the background.")}\n`);
          }
        }
      } catch (e) {
        sp.fail("initial push failed");
        throw e;
      }
    } else if (plan.firstSync === "sync") {
      const sp = spinner("syncing from remote — scanning files");
      const populate = createPopulateStatusWriter(plan.root, authed);
      try {
        await populate.start();
        deps.onProgress = (done, total, phase, detail, bytes) => {
          sp.update(progressLabel(phase, done, total, detail, bytes));
          populate.update(done, total, phase, bytes);
        };
        const { pulled, pushedSequence, initialRemoteSequence } = await sync(plan.root, authed, deps);
        sp.stop();
        const conflicts = pulled.filter((a) => a.kind === "conflict");
        const writes = pulled.filter((a) => a.kind === "write").length;
        console.log(
          `${style.bold("synced")}: ${style.green(`${writes} pulled`)}, ${conflicts.length ? style.red(`${conflicts.length} conflict(s)`) : style.dim("0 conflict(s)")} ${style.sym.arrow} sequence ${style.cyan(String(pushedSequence))}`
        );
        flushGitSummaries();
        for (const c of conflicts) console.log(`  ${style.sym.warn} ${style.yellow(c.path ?? "?")} ${style.dim(`(local kept as ${c.keepLocalAs})`)}`);
        writeGuidedGenesisPullNotice(opts.guidedSetup, initialRemoteSequence);
      } catch (e) {
        sp.fail("initial sync failed");
        throw e;
      } finally {
        await populate.stop();
      }
    } else if (plan.firstSync === "pull") {
      const sp = spinner("pulling from remote");
      const populate = createPopulateStatusWriter(plan.root, authed);
      try {
        await populate.start();
        deps.onProgress = (done, total, phase, detail, bytes) => {
          sp.update(progressLabel(phase, done, total, detail, bytes));
          populate.update(done, total, phase, bytes);
        };
        const actions = await pull(plan.root, authed, deps);
        sp.stop();
        const conflicts = actions.filter((a) => a.kind === "conflict");
        const writes = actions.filter((a) => a.kind === "write").length;
        console.log(`${style.bold("pulled")}: ${style.green(`${writes} written`)}, ${conflicts.length ? style.red(`${conflicts.length} conflict(s)`) : style.dim("0 conflict(s)")}`);
      } catch (e) {
        sp.fail("initial pull failed");
        throw e;
      } finally {
        await populate.stop();
      }
    }
  } finally {
    if (ownsSyncMutex) await releaseWorkspaceSyncMutex(syncMutex);
  }

  // 6. Done — show how to bring another machine online (unless the caller, e.g.
  //    `setup`, prints its own unified summary instead).
  if (opts.summary) {
    const workspaceName = plan.workspace.name || path.basename(plan.root);
    console.log(`\n${style.sym.ok} ${style.bold("rbox is set up.")}`);
    console.log(`  ${style.dim("workspace:")} ${style.cyan(workspaceName)}     ${style.dim("device:")} ${os.hostname()}`);
    console.log(`\n${style.dim("Link another machine:")}\n  rbox login   ${style.dim("# on the other machine, then:")}\n  rbox init --workspace ${workspaceId} --root <path>`);
  }
  return { workspaceId, workspaceName: plan.workspace.name || path.basename(plan.root), deviceId, root: plan.root };
}
