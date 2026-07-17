#!/usr/bin/env bun
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readCredentials, redactSecret, resolveBootstrapSecret } from "../rig/lib/account.js";
import {
  configureUxRuntime, containerExecPrefix, containerRboxEnv, destroyUxContainer,
  ensureUxContainer, execUx, guestMachineHome, listUxContainers, startUxContainerForTeardown, uxDestroyScope,
} from "./container.js";
import { assertNoAncestorWorkspace, DEV_API, executionMode, isolatedEnv, safeId, SCRUBBED_ENV, shellQuote, UX_ROOT } from "./lib.js";

export { assertNoAncestorWorkspace, DEV_API, executionMode, isolatedEnv, safeId, SCRUBBED_ENV, UX_ROOT } from "./lib.js";

export type BootstrapPlan = "solo" | "pro" | "none";
export type FreshArgs =
  | { command: "create"; name: string; enrolled: boolean; plan: BootstrapPlan; runId?: string; host: boolean }
  | { command: "destroy"; runId: string; name?: string; host: boolean }
  | { command: "list"; host: boolean }
  | { command: "workspaces"; runId: string; name: string; host: boolean }
  | { command: "workspaces-create"; runId: string; name: string; label: string; host: boolean };
function failUsage(message: string): never {
  throw new Error(`${message}\nusage: fresh-machine.ts create --name <name> [--enrolled [--plan <solo|pro|none>]] [--run-id <id>] [--host] | destroy --run-id <id> [--name <name>] [--host] | list [--host] | workspaces --run-id <id> --name <name> [--host] | workspaces-create --run-id <id> --name <name> --label <label> [--host]`);
}
export function machineLabel(runId: string, name: string): string {
  return `ux-${safeId("run id", runId)}-${safeId("machine name", name)}`;
}
function options(tokens: string[], allowed: Set<string>, booleans = new Set<string>()): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const key = tokens[i]!;
    if (!allowed.has(key)) failUsage(`unknown option: ${key}`);
    if (result.has(key)) failUsage(`duplicate option: ${key}`);
    if (booleans.has(key)) result.set(key, "true");
    else {
      const value = tokens[++i];
      if (value === undefined || value.startsWith("--")) failUsage(`${key} needs a value`);
      result.set(key, value);
    }
  }
  return result;
}
export function parseFreshArgs(argv: string[]): FreshArgs {
  const [command, ...rest] = argv;
  if (command === "list") {
    const o = options(rest, new Set(["--host"]), new Set(["--host"]));
    return { command, host: o.has("--host") };
  }
  if (command === "create") {
    const o = options(rest, new Set(["--name", "--enrolled", "--plan", "--run-id", "--host"]), new Set(["--enrolled", "--host"]));
    const name = o.get("--name"); if (!name) failUsage("create requires --name");
    const runId = o.get("--run-id");
    const enrolled = o.has("--enrolled"); const rawPlan = o.get("--plan");
    if (rawPlan !== undefined && !enrolled) failUsage("--plan requires --enrolled");
    if (rawPlan !== undefined && rawPlan !== "solo" && rawPlan !== "pro" && rawPlan !== "none") failUsage("--plan must be solo, pro, or none");
    const plan: BootstrapPlan = enrolled ? (rawPlan as BootstrapPlan | undefined) ?? "solo" : "none";
    return { command, name: safeId("machine name", name), enrolled, plan, host: o.has("--host"), ...(runId ? { runId: safeId("run id", runId) } : {}) };
  }
  if (command === "destroy") {
    const o = options(rest, new Set(["--run-id", "--name", "--host"]), new Set(["--host"]));
    const runId = o.get("--run-id"); if (!runId) failUsage("destroy requires --run-id");
    const name = o.get("--name");
    return { command, runId: safeId("run id", runId), host: o.has("--host"), ...(name ? { name: safeId("machine name", name) } : {}) };
  }
  if (command === "workspaces" || command === "workspaces-create") {
    const allowed = command === "workspaces" ? new Set(["--run-id", "--name", "--host"]) : new Set(["--run-id", "--name", "--label", "--host"]);
    const o = options(rest, allowed, new Set(["--host"]));
    const runId = o.get("--run-id"); if (!runId) failUsage(`${command} requires --run-id`);
    const name = o.get("--name"); if (!name) failUsage(`${command} requires --name`);
    if (command === "workspaces-create") {
      const label = o.get("--label"); if (!label) failUsage("workspaces-create requires --label");
      return { command, runId: safeId("run id", runId), name: safeId("machine name", name), label, host: o.has("--host") };
    }
    return { command, runId: safeId("run id", runId), name: safeId("machine name", name), host: o.has("--host") };
  }
  return failUsage(command ? `unknown command: ${command}` : "missing command");
}
export function assertDevRemote(remote: string): void {
  if (remote !== DEV_API) throw new Error(`refusing non-DEV rbox remote: ${remote}`);
}
export function envPrefix(home: string): string {
  const unset = SCRUBBED_ENV.map((key) => `-u ${key}`).join(" ");
  return `cd ${shellQuote(home)} && env ${unset} HOME=${shellQuote(home)} RBOX_HOME=${shellQuote(home)} RBOX_API=${shellQuote(DEV_API)} RBOX_API_QUIET=1 RBOX_APP='' rbox`;
}
export function normalizedBootstrapEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, RBOX_DEV_BOOTSTRAP: env.RBOX_DEV_BOOTSTRAP?.trim() || env.RBOX_DEV_BOOTSTRAP_SECRET?.trim() };
}
async function ensureRoot(): Promise<void> {
  await fsp.mkdir(UX_ROOT, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(UX_ROOT);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${UX_ROOT} must be a real directory, not a symlink`);
}
export function isCanonicalChild(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
export async function assertMachineHome(home: string): Promise<string> {
  await ensureRoot();
  const relative = path.relative(UX_ROOT, path.resolve(home)); const parts = relative.split(path.sep);
  if (parts.length !== 2) throw new Error(`machine HOME must be ${UX_ROOT}/<run-id>/<name>: ${home}`);
  safeId("run id", parts[0]!); safeId("machine name", parts[1]!);
  for (const candidate of [path.join(UX_ROOT, parts[0]!), path.join(UX_ROOT, relative)]) {
    const stat = await fsp.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`machine path must be a real directory: ${candidate}`);
  }
  const [canonicalRoot, real] = await Promise.all([fsp.realpath(UX_ROOT), fsp.realpath(path.join(UX_ROOT, relative))]);
  if (!isCanonicalChild(canonicalRoot, real)) throw new Error(`machine HOME escapes ${UX_ROOT}`);
  return path.join(UX_ROOT, relative);
}
export function rboxSpawnOptions(home: string) {
  return { cwd: home, env: isolatedEnv(home), stdout: "pipe" as const, stderr: "pipe" as const };
}
export function childFailure(stage: string, exit: number, _capturedOutput?: string): Error {
  return new Error(`${stage} failed (rbox exit ${exit}); child output suppressed to protect secrets`);
}
async function runHostRbox(home: string, args: string[], stage: string): Promise<void> {
  assertDevRemote(DEV_API); await assertNoAncestorWorkspace(home);
  const child = Bun.spawn(["rbox", ...args], rboxSpawnOptions(home));
  await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()]);
  const exit = await child.exited; if (exit !== 0) throw childFailure(stage, exit);
}

async function runGuestRbox(runId: string, home: string, args: string[], stage: string, extraEnv: Record<string, string> = {}, allowStale = false): Promise<void> {
  assertDevRemote(DEV_API);
  const result = await execUx(runId, ["rbox", ...args], { home, env: { ...containerRboxEnv(home), ...extraEnv }, allowFail: true, allowStale, redact: Object.values(extraEnv) });
  if (result.exitCode !== 0) throw childFailure(stage, result.exitCode);
}

function resolveSecret(): string {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  return resolveBootstrapSecret(repoRoot, { env: normalizedBootstrapEnv(process.env), readFile: (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return undefined; } } });
}

export function bootstrapPlanArgs(plan: BootstrapPlan): string[] {
  return plan === "none" ? [] : ["--plan", plan];
}

export function hostBootstrapLoginArgs(secret: string, label: string, plan: BootstrapPlan): string[] {
  return ["login", "--bootstrap", secret, "--label", label, "--remote", DEV_API, ...bootstrapPlanArgs(plan)];
}

export function containerBootstrapLoginCommand(label: string, plan: BootstrapPlan): string[] {
  return [
    "sh", "-c", 'exec rbox login --bootstrap "$RBOX_UX_BOOTSTRAP" "$@"', "ux-login",
    "--label", label, "--remote", DEV_API, ...bootstrapPlanArgs(plan),
  ];
}

async function createHost(args: Extract<FreshArgs, { command: "create" }>, runId: string): Promise<void> {
  await ensureRoot(); const runDir = path.join(UX_ROOT, runId); await fsp.mkdir(runDir, { recursive: true, mode: 0o700 });
  if ((await fsp.lstat(runDir)).isSymbolicLink()) throw new Error(`run directory may not be a symlink: ${runDir}`);
  const home = path.join(runDir, args.name); await fsp.mkdir(home, { mode: 0o700 }); await assertMachineHome(home); await assertNoAncestorWorkspace(home);
  if (args.enrolled) await withFailureCleanup(async () => {
    const secret = resolveSecret();
    await runHostRbox(home, hostBootstrapLoginArgs(secret, machineLabel(runId, args.name), args.plan), "DEV bootstrap login");
    await runHostRbox(home, ["key", "genesis", "--yes"], "key genesis");
  }, () => teardownHost(home));
  process.stdout.write(`HOME=${home}\n${envPrefix(home)} …\n`);
}

async function createContainer(args: Extract<FreshArgs, { command: "create" }>, runId: string): Promise<void> {
  await ensureUxContainer(runId); const home = guestMachineHome(runId, args.name); const runDir = path.posix.dirname(home);
  await execUx(runId, ["mkdir", "-p", "-m", "700", "--", runDir]);
  await execUx(runId, ["mkdir", "-m", "700", "--", home]);
  if (args.enrolled) await withFailureCleanup(async () => {
    const secret = resolveSecret();
    const login = await execUx(runId, containerBootstrapLoginCommand(machineLabel(runId, args.name), args.plan), { home, env: { ...containerRboxEnv(home), RBOX_UX_BOOTSTRAP: secret }, allowFail: true, redact: [secret] });
    if (login.exitCode !== 0) throw childFailure("DEV bootstrap login", login.exitCode);
    await runGuestRbox(runId, home, ["key", "genesis", "--yes"], "key genesis");
  }, () => teardownGuest(runId, home));
  process.stdout.write(`HOME=${home}\n${containerExecPrefix(runId, home)} …\n`);
}

export async function withFailureCleanup(work: () => Promise<void>, cleanupWork: () => Promise<void>): Promise<void> {
  try { await work(); } catch (error) { await cleanupWork().catch(safeWarning); throw error; }
}

export async function readRegularFile(file: string): Promise<string> {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`refusing non-regular or symlink file: ${file}`);
  return fsp.readFile(file, "utf8");
}

export async function desiredRootsHost(home: string): Promise<string[]> {
  const dir = path.join(home, ".rbox", "daemons");
  for (const parent of [path.join(home, ".rbox"), dir]) {
    try { const stat = await fsp.lstat(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`refusing symlinked state directory: ${parent}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []); const roots = new Set<string>();
  for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) try {
    const parsed = JSON.parse(await readRegularFile(path.join(dir, entry.name, "desired.json"))) as { rootPath?: unknown };
    if (typeof parsed.rootPath === "string" && path.isAbsolute(parsed.rootPath)) roots.add(parsed.rootPath);
  } catch { /* absent or malformed desired state */ }
  return [...roots];
}

function safeWarning(error: unknown): void {
  let message = error instanceof Error ? error.message : String(error);
  message = redactSecret(redactSecret(message, process.env.RBOX_DEV_BOOTSTRAP), process.env.RBOX_DEV_BOOTSTRAP_SECRET);
  process.stderr.write(`warning: ${message}\n`);
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function storedWorkspaceCredentials(raw: string): { remote: string; token: string } {
  const parsed = JSON.parse(raw) as { remoteUrl?: unknown };
  const remote = typeof parsed.remoteUrl === "string" ? parsed.remoteUrl : "missing credential remote";
  assertDevRemote(remote);
  return { remote, token: readCredentials(raw).token };
}

export async function listWorkspaceIds(remote: string, token: string, fetchFn: FetchFn = fetch): Promise<string[]> {
  assertDevRemote(remote);
  const ids: string[] = []; let cursor: string | null = null;
  do {
    const url = new URL("/v1/account/workspaces", remote);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetchFn(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`workspace list failed (HTTP ${response.status}); response body suppressed`);
    const body = await response.json() as { workspaces?: unknown; nextCursor?: unknown };
    if (!Array.isArray(body.workspaces) || !body.workspaces.every((row) => row && typeof row === "object" && typeof (row as { workspaceId?: unknown }).workspaceId === "string")) {
      throw new Error("workspace list returned an invalid response");
    }
    ids.push(...body.workspaces.map((row) => (row as { workspaceId: string }).workspaceId));
    if (body.nextCursor !== null && body.nextCursor !== undefined && typeof body.nextCursor !== "string") throw new Error("workspace list returned an invalid cursor");
    cursor = typeof body.nextCursor === "string" && body.nextCursor ? body.nextCursor : null;
  } while (cursor);
  return ids;
}

export async function createWorkspaceFixture(remote: string, token: string, label: string, fetchFn: FetchFn = fetch): Promise<string> {
  assertDevRemote(remote);
  const url = new URL("/v1/workspaces", remote);
  url.searchParams.set("project", "root");
  url.searchParams.set("name", label);
  const response = await fetchFn(url, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`workspace create failed (HTTP ${response.status}); response body suppressed`);
  const body = await response.json() as { workspaceId?: unknown };
  if (typeof body.workspaceId !== "string" || !body.workspaceId) throw new Error("workspace create returned an invalid response");
  return body.workspaceId;
}

async function workspaceCredentialsForMachine(args: { runId: string; name: string }, mode: "host" | "container"): Promise<{ remote: string; token: string }> {
  const home = mode === "host" ? await assertMachineHome(path.join(UX_ROOT, args.runId, args.name)) : guestMachineHome(args.runId, args.name);
  const file = mode === "host"
    ? await readRegularFile(path.join(home, ".rbox", "credentials.json"))
    : (await execUx(args.runId, ["cat", "--", path.posix.join(home, ".rbox", "credentials.json")], { allowFail: true })).stdout;
  return storedWorkspaceCredentials(file);
}

async function runWorkspaceHelper(args: Extract<FreshArgs, { command: "workspaces" | "workspaces-create" }>, mode: "host" | "container"): Promise<void> {
  const creds = await workspaceCredentialsForMachine(args, mode);
  if (args.command === "workspaces") {
    const ids = await listWorkspaceIds(creds.remote, creds.token);
    process.stdout.write(`count=${ids.length}\n${ids.map((id) => `${id}\n`).join("")}`);
  } else {
    const workspaceId = await createWorkspaceFixture(creds.remote, creds.token, args.label);
    process.stdout.write(`workspaceId=${workspaceId}\n`);
  }
}

async function teardownHost(home: string): Promise<void> {
  try {
    for (const root of await desiredRootsHost(home)) await runHostRbox(home, ["stop", root], `stop daemon for ${root}`).catch(safeWarning);
    try {
      const state = path.join(home, ".rbox"); const stateStat = await fsp.lstat(state);
      if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) throw new Error(`refusing symlinked state directory: ${state}`);
      const raw = await readRegularFile(path.join(home, ".rbox", "credentials.json")); const creds = readCredentials(raw);
      const remote = (JSON.parse(raw) as { remoteUrl?: unknown }).remoteUrl; assertDevRemote(typeof remote === "string" ? remote : "missing credential remote");
      if (creds.deviceId) await runHostRbox(home, ["device", "revoke", creds.deviceId], "device revoke");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") safeWarning(error); }
  } finally { await fsp.rm(home, { recursive: true, force: true }); }
}

async function guestDesiredRoots(runId: string, home: string, allowStale: boolean): Promise<string[]> {
  const found = await execUx(runId, ["find", path.posix.join(home, ".rbox", "daemons"), "-mindepth", "2", "-maxdepth", "2", "-name", "desired.json", "-type", "f", "-print"], { allowFail: true, allowStale });
  const roots = new Set<string>();
  for (const file of found.stdout.split("\n").filter(Boolean)) {
    const raw = await execUx(runId, ["cat", "--", file], { allowFail: true, allowStale });
    try { const root = (JSON.parse(raw.stdout) as { rootPath?: unknown }).rootPath; if (typeof root === "string" && path.posix.isAbsolute(root)) roots.add(root); } catch { /* malformed */ }
  }
  return [...roots];
}

async function teardownGuest(runId: string, home: string, allowStale = false): Promise<void> {
  try {
    for (const root of await guestDesiredRoots(runId, home, allowStale)) await runGuestRbox(runId, home, ["stop", root], `stop daemon for ${root}`, {}, allowStale).catch(safeWarning);
    try {
      const result = await execUx(runId, ["cat", "--", path.posix.join(home, ".rbox", "credentials.json")], { allowFail: true, allowStale });
      if (result.exitCode === 0) {
        const creds = readCredentials(result.stdout); const remote = (JSON.parse(result.stdout) as { remoteUrl?: unknown }).remoteUrl;
        assertDevRemote(typeof remote === "string" ? remote : "missing credential remote");
        if (creds.deviceId) await runGuestRbox(runId, home, ["device", "revoke", creds.deviceId], "device revoke", {}, allowStale);
      }
    } catch (error) { safeWarning(error); }
  } finally { await execUx(runId, ["rm", "-rf", "--", home], { allowFail: true, allowStale }); }
}

async function destroyHost(args: Extract<FreshArgs, { command: "destroy" }>): Promise<void> {
  await ensureRoot(); const runDir = path.join(UX_ROOT, args.runId);
  const names = args.name ? [args.name] : (await fsp.readdir(runDir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name);
  for (const name of names) try { await teardownHost(await assertMachineHome(path.join(runDir, safeId("machine name", name)))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") safeWarning(error); }
  await fsp.rmdir(runDir).catch(() => {});
}

async function destroyContainer(args: Extract<FreshArgs, { command: "destroy" }>): Promise<void> {
  const state = await startUxContainerForTeardown(args.runId); if (!state) return;
  const allowStale = state.ownership === "owned-stale";
  const runDir = path.posix.join(UX_ROOT, args.runId);
  let names = args.name ? [args.name] : [];
  if (!args.name) try { names = (await execUx(args.runId, ["find", runDir, "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-printf", "%f\\n"], { allowFail: true, allowStale })).stdout.split("\n").filter((name) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)); }
  catch (error) { safeWarning(error); }
  for (const name of names) await teardownGuest(args.runId, guestMachineHome(args.runId, name), allowStale).catch(safeWarning);
  if (uxDestroyScope(args.name) === "run") await destroyUxContainer(args.runId);
}

async function listHost(): Promise<void> {
  await ensureRoot();
  for (const run of (await fsp.readdir(UX_ROOT, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(run.name)) continue;
    for (const machine of (await fsp.readdir(path.join(UX_ROOT, run.name), { withFileTypes: true })).filter((e) => e.isDirectory() && !e.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name))) {
      if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(machine.name)) process.stdout.write(`${run.name}/${machine.name}\t${machineLabel(run.name, machine.name)}\t${await assertMachineHome(path.join(UX_ROOT, run.name, machine.name))}\n`);
    }
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseFreshArgs(argv); const mode = executionMode(args.host);
  if (mode === "container") configureUxRuntime();
  if (args.command === "create") { const runId = args.runId ?? randomBytes(4).toString("hex"); await (mode === "host" ? createHost(args, runId) : createContainer(args, runId)); }
  else if (args.command === "destroy") await (mode === "host" ? destroyHost(args) : destroyContainer(args));
  else if (args.command === "workspaces" || args.command === "workspaces-create") await runWorkspaceHelper(args, mode);
  else if (mode === "host") await listHost(); else { const listed = await listUxContainers(); if (listed) process.stdout.write(`${listed}\n`); }
}

if (import.meta.main) main().catch((error) => { safeWarning(error); process.exitCode = 1; });
