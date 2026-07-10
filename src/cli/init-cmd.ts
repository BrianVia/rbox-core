/**
 * `rbox init` — the impure shell over the pure planner (design 07c §1, §7).
 *
 * Responsibilities: gather inputs (prompting on stderr ONLY when interactive),
 * hand them to `resolveInitPlan`, and execute the resulting plan by orchestrating
 * existing primitives (login, createRemoteWorkspace, config write, first sync).
 * All decision logic lives in init-plan.ts; this file is presentation + I/O.
 */
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { loadCredentials, type Credentials } from "./credentials.js";
import { createRemoteWorkspace } from "./remote.js";
import { loadConfig, resetSyncState, saveConfig, syncStreamId, type WorkspaceConfig } from "./config.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { hasDevice } from "./e2ee-keystore.js";
import { login } from "./auth-cmd.js";
import { pull, push, sync } from "./sync.js";
import { resolveInitPlan, isInitError, collapseHome, interpretWorkspaceNameAnswer, type InitPlan } from "./init-plan.js";
import { style, stderrStyle, fail } from "./style.js";
import { spinner } from "./spinner.js";
import { progressLabel } from "./status-view.js";
import { promptSelect, promptInput } from "./prompt.js";
import { promptWorkspacePick } from "./workspace-picker.js";
import { recoveryKitOptionsFromFlags, type RecoveryKitOptions } from "./recovery-kit.js";
import { createPopulateStatusWriter } from "./populate-status.js";
import { acquireWorkspaceSyncMutex, releaseWorkspaceSyncMutex } from "./sync-mutex.js";

/**
 * Gather the missing init inputs interactively (all widgets render on stderr, so
 * `rbox init > out.txt` never pollutes stdout). Callers gate this on a TTY —
 * inquirer requires one. `ctx` carries the creds/remote the join picker needs.
 */
async function promptMissing(
  flags: Record<string, string>,
  cwd: string,
  ctx: { creds: Credentials | undefined; defaultRemote: string }
): Promise<Record<string, string>> {
  const next = { ...flags };
  if (next.new !== "true" && !next.workspace) {
    const choice = await promptSelect<"new" | "join">({
      message: "New workspace, or join an existing one?",
      choices: [
        { name: "Create a new workspace", value: "new" },
        { name: "Join an existing workspace", value: "join", description: "pick one you've already synced" },
      ],
    });
    if (choice === "join") {
      // Pick by name (degrades to a manual id prompt offline / no creds / empty).
      const picked = await promptWorkspacePick({ baseUrl: ctx.creds?.remoteUrl ?? ctx.defaultRemote, token: ctx.creds?.token });
      // Backing out of the picker (blank manual entry) falls through as a NEW
      // workspace — mirrors the old "[new]" default when nothing was entered.
      if (picked) {
        next.workspace = picked.workspaceId;
        // Cache the picked name locally so `rbox status` shows it (manual entry has none).
        if (picked.name) next.name = picked.name;
      }
    }
  }
  if (!next.project) {
    const ans = (await promptInput({ message: "Project id", default: "root" })).trim();
    if (ans) next.project = ans;
  }
  if (!next.root) {
    const ans = (await promptInput({ message: "Sync which directory?", default: cwd })).trim();
    if (ans) next.root = ans;
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
    const ans = interpretWorkspaceNameAnswer(await promptInput({ message: `Workspace name (Enter accepts, "-" for none)`, default: suggestion }));
    if (ans) next.name = ans;
  }
  if (!next.workspace && next["respect-gitignore"] == null) {
    next["respect-gitignore"] = await promptSelect<"false" | "true">({
      message: "How should rbox handle gitignored files?",
      choices: [
        { name: "Sync everything (current behavior)", value: "false" },
        {
          name: "Skip gitignored untracked files",
          value: "true",
          description: "build output and caches stay local; re-include notes/state in .rboxignore",
        },
      ],
    });
  }
  return next;
}

/** What an executed init produced — returned so callers like `setup` can print a
 *  unified summary (with `summary: false`) instead of init's own trailing block. */
export interface InitOutcome {
  workspaceId: string;
  deviceId: string;
  root: string;
}

export async function runInit(
  flags: Record<string, string>,
  opts: { cwd: string; defaultRemote: string; summary?: boolean }
): Promise<InitOutcome | undefined> {
  const creds = await loadCredentials();
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
  return executeInitPlan(plan, gathered.bootstrap, { summary: opts.summary !== false, recoveryKit: recoveryKitOptionsFromFlags(gathered) });
}

async function executeInitPlan(
  plan: InitPlan,
  bootstrapSecret: string | undefined,
  opts: { summary: boolean; recoveryKit: RecoveryKitOptions }
): Promise<InitOutcome | undefined> {
  // 1. Auth: bootstrap-login works headlessly (one-shot secret); device-code is
  //    interactive-only. "have" needs nothing. Never start device-code in CI.
  if (plan.auth === "bootstrap-login") {
    await login(plan.remoteUrl, bootstrapSecret, undefined, opts.recoveryKit);
  } else if (plan.auth === "need-interactive-login") {
    await login(plan.remoteUrl, undefined);
  }
  const creds = await loadCredentials();
  if (!creds) {
    fail("login did not produce a credential — aborting init.");
    return undefined;
  }
  const deviceId =
    plan.deviceId.kind === "fixed"
      ? plan.deviceId.id
      : creds.deviceId !== "env"
        ? creds.deviceId
        : `dev_${crypto.randomUUID().slice(0, 8)}`;

  // 2. Workspace: create (new) or adopt the id (join — first sync validates access).
  let workspaceId: string;
  const ws = spinner(plan.workspace.kind === "new" ? "creating workspace" : "joining workspace");
  try {
    workspaceId =
      plan.workspace.kind === "new"
        ? await createRemoteWorkspace(plan.remoteUrl, creds.token, plan.workspace.project, plan.workspace.name)
        : plan.workspace.id;
    ws.succeed(`workspace ${style.cyan(workspaceId)}`);
  } catch (e) {
    ws.fail("workspace setup failed");
    throw e;
  }

  // Init/setup owns one mutex across the complete rebind/reset + first-sync
  // decision, mutation, and state-save interval. Nested pull/push calls inherit it.
  const syncMutex = await acquireWorkspaceSyncMutex(plan.root, "cli");
  try {
    // 3. Write the per-device binding (token injected at runtime, never persisted).
    //    REBIND (design 44): if this root was already bound to a DIFFERENT workspace,
    //    its sync baseline describes the OLD stream — reconciling the new one against
    //    it reads every old file as remotely deleted (the 2026-07-01 mass-delete
    //    incident). Reset the baseline explicitly (loadState also guards via the
    //    stream stamp; this keeps the on-disk state truthful) and say so.
    const prev = await loadConfig(plan.root).catch(() => undefined);
    const nextStream = syncStreamId({ remoteUrl: plan.remoteUrl, remoteWorkspaceId: workspaceId, projectId: plan.workspace.project });
    if (prev && syncStreamId(prev) !== nextStream) {
      await resetSyncState(plan.root, nextStream, syncMutex);
      process.stderr.write(
        `${stderrStyle.yellow("!")} this directory was bound to workspace ${prev.remoteWorkspaceId} — ` +
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
    const { cfg: authed, deps } = await buildAuthedRemote(plan.root);
    deps.syncMutex = syncMutex;
    if (plan.firstSync === "push") {
      const sp = spinner("publishing initial snapshot — scanning files");
      try {
        deps.onProgress = (done, total, phase, detail, bytes) => sp.update(progressLabel(phase, done, total, detail, bytes));
        const { sequence: seq, committed } = await push(plan.root, authed, deps);
        // Never report a publish that didn't happen (design 44): the incident setup
        // printed "published → sequence 75" for a push that uploaded zero bytes.
        sp.succeed(
          committed
            ? `published ${style.sym.arrow} sequence ${style.cyan(String(seq))}`
            : `already in sync — nothing to upload ${style.dim(`(sequence ${seq})`)}`
        );
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
        const { pulled, pushedSequence } = await sync(plan.root, authed, deps);
        sp.stop();
        const conflicts = pulled.filter((a) => a.kind === "conflict");
        const writes = pulled.filter((a) => a.kind === "write").length;
        console.log(
          `${style.bold("synced")}: ${style.green(`${writes} pulled`)}, ${conflicts.length ? style.red(`${conflicts.length} conflict(s)`) : style.dim("0 conflict(s)")} ${style.sym.arrow} sequence ${style.cyan(String(pushedSequence))}`
        );
        for (const c of conflicts) console.log(`  ${style.sym.warn} ${style.yellow(c.path ?? "?")} ${style.dim(`(local kept as ${c.keepLocalAs})`)}`);
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
    await releaseWorkspaceSyncMutex(syncMutex);
  }

  // 6. Done — show how to bring another machine online (unless the caller, e.g.
  //    `setup`, prints its own unified summary instead).
  if (opts.summary) {
    console.log(`\n${style.sym.ok} ${style.bold("rbox is set up.")}`);
    console.log(`  ${style.dim("workspace:")} ${style.cyan(workspaceId)}`);
    console.log(`  ${style.dim("device:")}    ${deviceId}`);
    console.log(`\n${style.dim("Link another machine:")}\n  rbox login   ${style.dim("# on the other machine, then:")}\n  rbox init --workspace ${workspaceId} --root <path>`);
  }
  return { workspaceId, deviceId, root: plan.root };
}
