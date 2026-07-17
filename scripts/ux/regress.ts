#!/usr/bin/env bun
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { deleteAccount, readCredentials } from "../rig/lib/account.js";
import * as Container from "../rig/lib/container.js";
import {
  configureUxRuntime, containerRboxEnv, execUx, guestMachineHome,
} from "./container.js";
import { assertDevRemote, DEV_API } from "./fresh-machine.js";
import type { FlowDefinition, FlowStep, MachineSpec } from "./flow.js";
import { stepKind } from "./flow.js";

export const RUNS_DIR = path.join(import.meta.dir, "runs");
const DEFAULT_TIMEOUT = 60;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface CommandResult { stdout: string; stderr: string; exitCode: number }

export interface RegressionHarness {
  createMachine(runId: string, machine: MachineSpec): Promise<void>;
  execRbox(runId: string, machine: string, argv: string[]): Promise<CommandResult>;
  guest(runId: string, machine: string, command: string): Promise<CommandResult>;
  startTui(runId: string, machine: string, session: string, command: string): Promise<void>;
  keys(runId: string, machine: string, session: string, keys: string[]): Promise<void>;
  pasteBuffer(runId: string, machine: string, session: string, value: string): Promise<void>;
  waitIdle(runId: string, machine: string, session: string, timeout: number): Promise<string>;
  screen(runId: string, machine: string, session: string): Promise<string>;
  stopTui(runId: string, machine: string, session: string): Promise<void>;
  deleteBootstrapAccount(runId: string, machine: string): Promise<{ ok: boolean; detail?: string }>;
  destroyFlow(runId: string): Promise<void>;
  auditResidue(runIds: string[]): Promise<string[]>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type Outcome = "PASS" | "FAIL" | "PENDING-FAIL" | "XPASS";

interface StepRecord {
  index: number;
  kind: string;
  on: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  screen?: string;
}

export interface FlowRunResult {
  flow: string;
  runId: string;
  outcome: Outcome;
  error?: string;
  accountLeak?: string;
  residue: string[];
  records: StepRecord[];
}

export class Redactor {
  readonly #values = new Set<string>();
  add(value: string): void { if (value) this.#values.add(value); }
  redact(value: string): string {
    let result = value;
    for (const secret of [...this.#values].sort((a, b) => b.length - a.length)) result = result.split(secret).join("[REDACTED]");
    return result;
  }
  value<T>(value: T): T { return JSON.parse(this.redact(JSON.stringify(value))) as T; }
}

function regexMatches(regex: RegExp, value: string): boolean { regex.lastIndex = 0; return regex.test(value); }
function shown(regex: RegExp): string { return `/${regex.source}/${regex.flags}`; }

function requireMatches(patterns: RegExp[] | undefined, value: string, field: string): void {
  for (const pattern of patterns ?? []) if (!regexMatches(pattern, value)) throw new Error(`${field} did not match ${shown(pattern)}`);
}

function expand(template: string, vars: Map<string, string>, machine: string): string {
  return template.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_whole, name: string) => {
    if (name === "MACHINE") return machine;
    const value = vars.get(name);
    if (value === undefined) throw new Error(`unknown flow variable ${name}`);
    return value;
  });
}

function resultOutput(record: StepRecord | undefined): string {
  if (!record) return "";
  if (record.screen !== undefined) return record.screen;
  return `${record.stdout ?? ""}${record.stderr ?? ""}`;
}

function assertCommand(step: Extract<FlowStep, { exec: string[] } | { guest: string }>, result: CommandResult): void {
  const expected = step.expectExit ?? 0;
  if (result.exitCode !== expected) throw new Error(`${stepKind(step)} exit ${result.exitCode}, expected ${expected}`);
  requireMatches(step.assertStdout, result.stdout, "stdout");
  requireMatches(step.assertStderr, result.stderr, "stderr");
}

async function executeSteps(
  flow: FlowDefinition,
  runId: string,
  harness: RegressionHarness,
  redactor: Redactor,
  records: StepRecord[],
  sessions: Map<string, string>,
): Promise<void> {
  const vars = new Map<string, string>([["RUN_ID", runId]]);
  for (let index = 0; index < flow.steps.length; index++) {
    const step = flow.steps[index]!;
    const kind = stepKind(step);
    if ("exec" in step) {
      const argv = step.exec.map((arg) => expand(arg, vars, step.on));
      const result = await harness.execRbox(runId, step.on, argv);
      records.push({ index, kind, on: step.on, ...result });
      assertCommand(step, result);
    } else if ("guest" in step) {
      const result = await harness.guest(runId, step.on, expand(step.guest, vars, step.on));
      records.push({ index, kind, on: step.on, ...result });
      assertCommand(step, result);
    } else if ("tui" in step) {
      const session = `rg-${runId}-${step.on}`.slice(0, 64);
      if (sessions.has(step.on)) throw new Error(`machine ${step.on} already has a live TUI session`);
      await harness.startTui(runId, step.on, session, expand(step.tui, vars, step.on));
      sessions.set(step.on, session);
      records.push({ index, kind, on: step.on });
    } else if ("keys" in step) {
      const session = sessions.get(step.on); if (!session) throw new Error(`machine ${step.on} has no live TUI session`);
      await harness.keys(runId, step.on, session, step.keys.map((key) => expand(key, vars, step.on)));
      records.push({ index, kind, on: step.on });
    } else if ("typeVar" in step) {
      const session = sessions.get(step.on); if (!session) throw new Error(`machine ${step.on} has no live TUI session`);
      const value = vars.get(step.typeVar); if (value === undefined) throw new Error(`unknown flow variable ${step.typeVar}`);
      await harness.pasteBuffer(runId, step.on, session, value);
      records.push({ index, kind, on: step.on });
    } else if ("waitFor" in step) {
      const session = sessions.get(step.on); if (!session) throw new Error(`machine ${step.on} has no live TUI session`);
      const timeout = step.timeout ?? DEFAULT_TIMEOUT; const deadline = harness.now() + timeout * 1000;
      let screen = await harness.waitIdle(runId, step.on, session, Math.min(timeout, 2));
      while (!regexMatches(step.waitFor, screen) && harness.now() < deadline) {
        await harness.sleep(250); screen = await harness.screen(runId, step.on, session);
      }
      records.push({ index, kind, on: step.on, screen });
      if (!regexMatches(step.waitFor, screen)) throw new Error(`waitFor ${shown(step.waitFor)} timed out after ${timeout}s\nfinal screen:\n${screen}`);
    } else if ("assertScreen" in step) {
      const session = sessions.get(step.on); if (!session) throw new Error(`machine ${step.on} has no live TUI session`);
      const screen = await harness.screen(runId, step.on, session);
      records.push({ index, kind, on: step.on, screen });
      requireMatches(step.assertScreen, screen, "screen");
      for (const pattern of step.assertNotScreen ?? []) if (regexMatches(pattern, screen)) throw new Error(`screen unexpectedly matched ${shown(pattern)}`);
    } else if ("pollUntil" in step) {
      const timeout = step.pollUntil.timeout ?? DEFAULT_TIMEOUT; const deadline = harness.now() + timeout * 1000;
      let result: CommandResult = { stdout: "", stderr: "", exitCode: -1 };
      do {
        result = await harness.execRbox(runId, step.on, step.pollUntil.exec.map((arg) => expand(arg, vars, step.on)));
        if (result.exitCode !== 0) throw new Error(`pollUntil exec exited ${result.exitCode}`);
        if (regexMatches(step.pollUntil.pattern, result.stdout)) break;
        if (harness.now() < deadline) await harness.sleep(500);
      } while (harness.now() < deadline);
      records.push({ index, kind, on: step.on, ...result });
      if (!regexMatches(step.pollUntil.pattern, result.stdout)) throw new Error(`pollUntil ${shown(step.pollUntil.pattern)} timed out after ${timeout}s; final stdout:\n${result.stdout}`);
    } else {
      const output = resultOutput(records.at(-1));
      step.captureVar.pattern.lastIndex = 0;
      const match = step.captureVar.pattern.exec(output);
      const captured = match?.[1] ?? match?.[0];
      if (!captured) throw new Error(`captureVar ${step.captureVar.name} did not match ${shown(step.captureVar.pattern)}`);
      vars.set(step.captureVar.name, captured); redactor.add(captured);
      records.push({ index, kind, on: step.on });
    }
  }
}

export function classify(flowStatus: FlowDefinition["status"], stepsPassed: boolean, infrastructureFailed = false): Outcome {
  if (infrastructureFailed) return "FAIL";
  if (flowStatus === "pending-137") return stepsPassed ? "XPASS" : "PENDING-FAIL";
  return stepsPassed ? "PASS" : "FAIL";
}

export function exitCodeForOutcomes(outcomes: Outcome[]): 0 | 1 {
  return outcomes.some((outcome) => outcome === "FAIL" || outcome === "XPASS") ? 1 : 0;
}

export async function runFlow(
  flow: FlowDefinition,
  runId: string,
  harness: RegressionHarness,
  artifactDir?: string,
): Promise<FlowRunResult> {
  const redactor = new Redactor(); const records: StepRecord[] = []; const sessions = new Map<string, string>();
  let stepsPassed = false; let infrastructureFailed = false; let error: string | undefined; let accountLeak: string | undefined;
  const created = new Set<string>(); let provisioned = false;
  try {
    for (const machine of flow.machines) { await harness.createMachine(runId, machine); created.add(machine.name); }
    provisioned = true;
    await executeSteps(flow, runId, harness, redactor, records, sessions);
    stepsPassed = true;
  } catch (caught) {
    if (!provisioned) infrastructureFailed = true;
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    for (const [machine, session] of sessions) try { await harness.stopTui(runId, machine, session); }
    catch (caught) { infrastructureFailed = true; error = `${error ? `${error}\n` : ""}TUI teardown: ${caught instanceof Error ? caught.message : String(caught)}`; }
    const owner = flow.machines.find((machine) => machine.enrolled && created.has(machine.name));
    if (owner) try {
      const deleted = await harness.deleteBootstrapAccount(runId, owner.name);
      if (!deleted.ok) accountLeak = deleted.detail ?? "account deletion failed";
    } catch (caught) { accountLeak = caught instanceof Error ? caught.message : String(caught); }
    try { await harness.destroyFlow(runId); }
    catch (caught) { infrastructureFailed = true; error = `${error ? `${error}\n` : ""}flow teardown: ${caught instanceof Error ? caught.message : String(caught)}`; }
  }
  let residue: string[] = [];
  try { residue = await harness.auditResidue([runId]); }
  catch (caught) { infrastructureFailed = true; error = `${error ? `${error}\n` : ""}residue audit: ${caught instanceof Error ? caught.message : String(caught)}`; }
  if (residue.length) { infrastructureFailed = true; error = `${error ? `${error}\n` : ""}residue: ${residue.join(", ")}`; }
  const result: FlowRunResult = redactor.value({
    flow: flow.name, runId, outcome: classify(flow.status, stepsPassed, infrastructureFailed),
    ...(error ? { error } : {}), ...(accountLeak ? { accountLeak } : {}), residue, records,
  });
  if (artifactDir) {
    await fsp.mkdir(artifactDir, { recursive: true });
    await fsp.writeFile(path.join(artifactDir, `${flow.name}.json`), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
  return result;
}

export async function runWithConcurrency<T, R>(items: T[], jobs: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error("jobs must be a positive integer");
  const results = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    for (;;) { const index = next++; if (index >= items.length) return; results[index] = await work(items[index]!, index); }
  }));
  return results;
}

export interface RetentionDeps { now?: number; isPidAlive?: (pid: number) => boolean }
export async function pruneRunDirs(root: string, deps: RetentionDeps = {}): Promise<string[]> {
  const now = deps.now ?? Date.now();
  const isPidAlive = deps.isPidAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const removed: string[] = [];
  for (const entry of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = path.join(root, entry.name); const stat = await fsp.stat(dir);
    if (now - stat.mtimeMs <= RETENTION_MS) continue;
    let live = false;
    try { const pid = Number((await fsp.readFile(path.join(dir, "run.lock"), "utf8")).trim()); live = Number.isInteger(pid) && pid > 0 && isPidAlive(pid); }
    catch { /* missing locks are inactive */ }
    if (!live) { await fsp.rm(dir, { recursive: true }); removed.push(entry.name); }
  }
  return removed;
}

async function spawn(argv: string[], options: { stdin?: string; allowFail?: boolean } = {}): Promise<CommandResult> {
  const child = Bun.spawn(argv, { stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0 && !options.allowFail) throw new Error(`${path.basename(argv[1] ?? argv[0] ?? "command")} exited ${exitCode}: ${stderr.trim()}`);
  return { stdout, stderr, exitCode };
}

function tuiArgv(command: string, runId: string, session: string, rest: string[] = []): string[] {
  return [process.execPath, path.join(import.meta.dir, "tui.ts"), command, "--run-id", runId, "--session", session, ...rest];
}

export function productionHarness(): RegressionHarness {
  configureUxRuntime();
  return {
    async createMachine(runId, machine) {
      const argv = [process.execPath, path.join(import.meta.dir, "fresh-machine.ts"), "create", "--run-id", runId, "--name", machine.name];
      if (machine.enrolled) argv.push("--enrolled");
      await spawn(argv);
    },
    execRbox: (runId, machine, argv) => execUx(runId, ["rbox", ...argv], { home: guestMachineHome(runId, machine), env: containerRboxEnv(guestMachineHome(runId, machine)), allowFail: true }),
    guest: (runId, machine, command) => execUx(runId, ["sh", "-c", command], { home: guestMachineHome(runId, machine), env: containerRboxEnv(guestMachineHome(runId, machine)), allowFail: true }),
    async startTui(runId, machine, session, command) {
      await spawn(tuiArgv("start", runId, session, ["--home", guestMachineHome(runId, machine), "--", "rbox", ...command.split(/\s+/).filter(Boolean)]));
    },
    async keys(runId, _machine, session, keys) { await spawn(tuiArgv("keys", runId, session, keys)); },
    async pasteBuffer(runId, _machine, session, value) { await spawn(tuiArgv("paste-buffer", runId, session), { stdin: value }); },
    async waitIdle(runId, _machine, session, timeout) { return (await spawn(tuiArgv("wait-idle", runId, session, ["--timeout", String(Math.max(1, Math.ceil(timeout)))]), { allowFail: true })).stdout; },
    async screen(runId, _machine, session) { return (await spawn(tuiArgv("screen", runId, session, ["--strip"]))).stdout; },
    async stopTui(runId, _machine, session) { await spawn(tuiArgv("stop", runId, session)); },
    async deleteBootstrapAccount(runId, machine) {
      const home = guestMachineHome(runId, machine);
      const result = await execUx(runId, ["cat", "--", path.posix.join(home, ".rbox", "credentials.json")], { allowFail: true });
      if (result.exitCode !== 0) return { ok: false, detail: "credentials unavailable before account deletion" };
      const raw = JSON.parse(result.stdout) as { remoteUrl?: unknown }; assertDevRemote(typeof raw.remoteUrl === "string" ? raw.remoteUrl : "missing credential remote");
      const creds = readCredentials(result.stdout); if (!creds.accountId) return { ok: false, detail: "credentials contain no account id" };
      const deleted = await deleteAccount(DEV_API, creds.token, creds.accountId);
      return { ok: deleted.ok, ...(!deleted.ok ? { detail: `accountId=${creds.accountId}\taccount delete ${deleted.status}: ${deleted.body.slice(0, 200)}` } : {}) };
    },
    async destroyFlow(runId) { await spawn([process.execPath, path.join(import.meta.dir, "fresh-machine.ts"), "destroy", "--run-id", runId]); },
    async auditResidue(runIds) {
      const residue: string[] = [];
      for (const runId of runIds) {
        const containers = await Container.run(["ps", "-a", "--filter", `label=ux.run=${runId}`, "--format", "{{.Names}}"], { allowFail: true });
        if (containers.exitCode !== 0) throw new Error(containers.stderr || "docker ps -a failed");
        residue.push(...containers.stdout.split("\n").filter(Boolean).map((name) => `container:${name}`));
        const volumes = await Container.run(["volume", "ls", "--filter", `label=ux.run=${runId}`, "--format", "{{.Name}}"], { allowFail: true });
        if (volumes.exitCode !== 0) throw new Error(volumes.stderr || "docker volume ls failed");
        residue.push(...volumes.stdout.split("\n").filter(Boolean).map((name) => `volume:${name}`));
      }
      return residue;
    },
    sleep: Bun.sleep,
    now: Date.now,
  };
}

export interface RegressArgs { flows: string[]; list: boolean; jobs: number; retryFlaky: number }
export function parseRegressArgs(argv: string[]): RegressArgs {
  const result: RegressArgs = { flows: [], list: false, jobs: 4, retryFlaky: 0 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--list") result.list = true;
    else if (arg === "--flow") { const name = argv[++index]; if (!name) throw new Error("--flow needs a name"); result.flows.push(name); }
    else if (arg === "--jobs") { const jobs = Number(argv[++index]); if (!Number.isInteger(jobs) || jobs < 1) throw new Error("--jobs needs a positive integer"); result.jobs = jobs; }
    else if (arg === "--retry-flaky") { const retries = Number(argv[++index]); if (retries !== 1) throw new Error("--retry-flaky currently accepts only 1"); result.retryFlaky = retries; }
    else throw new Error(`unknown option ${arg}`);
  }
  return result;
}

export async function loadFlows(directory = path.join(import.meta.dir, "flows")): Promise<FlowDefinition[]> {
  const files = (await fsp.readdir(directory)).filter((file) => file.endsWith(".flow.ts")).sort();
  const flows: FlowDefinition[] = [];
  for (const file of files) {
    const imported = await import(path.join(directory, file));
    const flow = imported.default ?? imported.flow;
    if (!flow) throw new Error(`${file} does not export a flow`);
    flows.push(flow as FlowDefinition);
  }
  const names = new Set<string>();
  for (const flow of flows) { if (names.has(flow.name)) throw new Error(`duplicate flow name ${flow.name}`); names.add(flow.name); }
  return flows;
}

function timestamp(): string { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
function makeRunId(flowName: string): string { return `rg-${flowName.slice(0, 24)}-${randomBytes(4).toString("hex")}`; }

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseRegressArgs(argv); const all = await loadFlows();
  if (args.list) { for (const flow of all) process.stdout.write(`${flow.name}\t${flow.status}\n`); return; }
  const selected = args.flows.length ? args.flows.map((name) => {
    const flow = all.find((candidate) => candidate.name === name); if (!flow) throw new Error(`unknown flow ${name}`); return flow;
  }) : all; // default runs EVERYTHING: pending flows must report (PENDING-FAIL) and
  // trip XPASS the moment their awaited design merges — excluding them mutes that.
  await fsp.mkdir(RUNS_DIR, { recursive: true }); await pruneRunDirs(RUNS_DIR);
  const artifactDir = path.join(RUNS_DIR, `${timestamp()}-${process.pid}-${randomBytes(2).toString("hex")}`);
  await fsp.mkdir(artifactDir, { recursive: true }); await fsp.writeFile(path.join(artifactDir, "run.lock"), `${process.pid}\n`, { mode: 0o600 });
  const harness = productionHarness(); const leaks: string[] = [];
  let results: FlowRunResult[] = [];
  try {
    results = await runWithConcurrency(selected, args.jobs, async (flow) => {
      let result = await runFlow(flow, makeRunId(flow.name), harness, artifactDir);
      if (args.retryFlaky && (result.outcome === "FAIL" || result.outcome === "XPASS")) result = await runFlow(flow, makeRunId(flow.name), harness, artifactDir);
      if (result.accountLeak) leaks.push(`${flow.name}\t${result.accountLeak}`);
      process.stdout.write(`${result.outcome}\t${flow.name}${result.error ? `\t${result.error.split("\n")[0]}` : ""}${result.accountLeak ? "\tACCOUNT-LEAK" : ""}\n`);
      return result;
    });
    if (leaks.length) await fsp.writeFile(path.join(artifactDir, "leaked-accounts.txt"), `${leaks.join("\n")}\n`, { mode: 0o600 });
    await fsp.writeFile(path.join(artifactDir, "summary.json"), `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
  } finally { await fsp.rm(path.join(artifactDir, "run.lock"), { force: true }); }
  process.exitCode = exitCodeForOutcomes(results.map((result) => result.outcome));
}

if (import.meta.main) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
