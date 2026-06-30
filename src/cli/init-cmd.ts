/**
 * `rbox init` — the impure shell over the pure planner (design 07c §1, §7).
 *
 * Responsibilities: gather inputs (prompting on stderr ONLY when interactive),
 * hand them to `resolveInitPlan`, and execute the resulting plan by orchestrating
 * existing primitives (login, createRemoteWorkspace, config write, first sync).
 * All decision logic lives in init-plan.ts; this file is presentation + I/O.
 */
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { loadCredentials } from "./credentials.js";
import { createRemoteWorkspace } from "./remote.js";
import { saveConfig, type WorkspaceConfig } from "./config.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { hasDevice } from "./e2ee-keystore.js";
import { login } from "./auth-cmd.js";
import { push, sync } from "./sync.js";
import { resolveInitPlan, isInitError, type InitPlan } from "./init-plan.js";
import { style, stderrStyle, fail } from "./style.js";
import { spinner } from "./spinner.js";

/** Prompt on stderr (so `rbox init > out.txt` never pollutes stdout). */
async function promptMissing(flags: Record<string, string>, cwd: string): Promise<Record<string, string>> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const next = { ...flags };
    if (next.new !== "true" && !next.workspace) {
      const ans = (await rl.question(`${stderrStyle.cyan("?")} New workspace, or an existing id to join? ${stderrStyle.dim("[new]")} `)).trim();
      if (ans && ans !== "new") next.workspace = ans;
    }
    if (!next.project) {
      const ans = (await rl.question(`${stderrStyle.cyan("?")} Project id ${stderrStyle.dim("[root]")} `)).trim();
      if (ans) next.project = ans;
    }
    if (!next.root) {
      const ans = (await rl.question(`${stderrStyle.cyan("?")} Sync which directory? ${stderrStyle.dim(`[${cwd}]`)} `)).trim();
      if (ans) next.root = ans;
    }
    return next;
  } finally {
    rl.close();
  }
}

export async function runInit(
  flags: Record<string, string>,
  opts: { cwd: string; defaultRemote: string }
): Promise<void> {
  const creds = await loadCredentials();
  const interactive = process.stdin.isTTY === true && flags["no-interactive"] !== "true";

  let gathered = flags;
  if (interactive) gathered = await promptMissing(flags, opts.cwd);

  const plan = resolveInitPlan({ flags: gathered, cwd: opts.cwd, creds, interactive, defaultRemote: opts.defaultRemote });
  if (isInitError(plan)) {
    fail(plan.message);
    process.stderr.write(`${stderrStyle.dim("try:")} ${plan.headlessHint}\n`);
    process.exitCode = 2;
    return;
  }
  await executeInitPlan(plan, gathered.bootstrap);
}

async function executeInitPlan(plan: InitPlan, bootstrapSecret: string | undefined): Promise<void> {
  // 1. Auth: bootstrap-login works headlessly (one-shot secret); device-code is
  //    interactive-only. "have" needs nothing. Never start device-code in CI.
  if (plan.auth === "bootstrap-login") {
    await login(plan.remoteUrl, bootstrapSecret);
  } else if (plan.auth === "need-interactive-login") {
    await login(plan.remoteUrl, undefined);
  }
  const creds = await loadCredentials();
  if (!creds) {
    fail("login did not produce a credential — aborting init.");
    return;
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
        ? await createRemoteWorkspace(plan.remoteUrl, creds.token, plan.workspace.project)
        : plan.workspace.id;
    ws.succeed(`workspace ${style.cyan(workspaceId)}`);
  } catch (e) {
    ws.fail("workspace setup failed");
    throw e;
  }

  // 3. Write the per-device binding (token injected at runtime, never persisted).
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
    process.exitCode = 2;
    return;
  }
  const { cfg: authed, deps } = await buildAuthedRemote(plan.root);
  if (plan.firstSync === "push") {
    const sp = spinner("publishing initial snapshot");
    try {
      deps.onProgress = (done, total, phase) => sp.update(`${phase === "upload" ? "uploading" : "encrypting"} ${done}/${total}`);
      const seq = await push(plan.root, authed, deps);
      sp.succeed(`published ${style.sym.arrow} sequence ${style.cyan(String(seq))}`);
    } catch (e) {
      sp.fail("initial push failed");
      throw e;
    }
  } else if (plan.firstSync === "sync") {
    const sp = spinner("syncing from remote");
    try {
      deps.onProgress = (done, total, phase) => sp.update(`${phase === "upload" ? "uploading" : phase === "download" ? "downloading" : phase} ${done}/${total}`);
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
    }
  }

  // 6. Done — show how to bring another machine online.
  console.log(`\n${style.sym.ok} ${style.bold("rbox is set up.")}`);
  console.log(`  ${style.dim("workspace:")} ${style.cyan(workspaceId)}`);
  console.log(`  ${style.dim("device:")}    ${deviceId}`);
  console.log(`\n${style.dim("Link another machine:")}\n  rbox login   ${style.dim("# on the other machine, then:")}\n  rbox init --workspace ${workspaceId} --root <path>`);
}
