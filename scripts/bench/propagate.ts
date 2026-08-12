#!/usr/bin/env bun
import { buildHopReport, renderHopReport, type PropagationClassification } from "../propagation-report.js";

const BENCH_DIR = "rbox-propagation-bench";
const SAMPLE_COUNT = 5;

export interface HostSpec { host: string; workspace: string; local: boolean }
interface Sample { low: number; high: number; midpoint: number }
interface ClockWindow { offset: number; width: number }

function usage(): never {
  throw new Error("usage: bun scripts/bench/propagate.ts [--ref-only] <LOCAL:/workspace|host:/workspace> <host:/workspace> [...]");
}

export function parseHostSpec(value: string, allowLocal: boolean): HostSpec {
  const split = value.indexOf(":");
  if (split < 1 || split === value.length - 1) usage();
  const host = value.slice(0, split);
  const workspace = value.slice(split + 1);
  if (!/^(?:LOCAL|[A-Za-z0-9_][A-Za-z0-9_.@-]*)$/.test(host) || !workspace.startsWith("/") || /[\r\n\0]/.test(workspace)) usage();
  const local = host === "LOCAL";
  if (local && !allowLocal) throw new Error("LOCAL is allowed only for the sender");
  return { host, workspace, local };
}

export function parseArgs(argv: string[]): { sender: HostSpec; receivers: HostSpec[]; refOnly: boolean } {
  const refOnly = argv[0] === "--ref-only";
  const specs = refOnly ? argv.slice(1) : argv;
  if (specs.length < 2) usage();
  return {
    sender: parseHostSpec(specs[0]!, true),
    receivers: specs.slice(1).map((value) => parseHostSpec(value, false)),
    refOnly,
  };
}

const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

async function onHost(spec: HostSpec, script: string, args: string[] = [], allowFail = false): Promise<string> {
  const shell = `sh -s -- ${args.map(quote).join(" ")}`;
  const command = spec.local
    ? ["sh", "-s", "--", ...args]
    : ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", spec.host, shell];
  const child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(script);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0 && !allowFail) throw new Error(`${spec.host}: ${stderr.trim() || `command exited ${exitCode}`}`);
  return exitCode === 0 ? stdout : "";
}

async function clockSample(spec: HostSpec): Promise<Sample> {
  const before = Date.now();
  const text = await onHost(spec, `bun -e 'process.stdout.write(JSON.stringify({wallMs:Date.now(),monotonicMs:performance.now()}))'\n`);
  const after = Date.now();
  const body = JSON.parse(text) as { wallMs?: unknown; monotonicMs?: unknown };
  if (!Number.isFinite(body.wallMs) || !Number.isFinite(body.monotonicMs)) throw new Error(`${spec.host}: invalid clock sample`);
  const wall = body.wallMs as number;
  return { low: wall - after, high: wall - before, midpoint: wall - ((before + after) / 2) };
}

async function clockWindow(spec: HostSpec): Promise<ClockWindow> {
  const samples = await Promise.all(Array.from({ length: SAMPLE_COUNT }, () => clockSample(spec)));
  const best = samples.sort((a, b) => (a.high - a.low) - (b.high - b.low))[0]!;
  return { offset: best.midpoint, width: best.high - best.low };
}

export function clockSkewBound(preA: ClockWindow, postA: ClockWindow, preB: ClockWindow, postB: ClockWindow): { boundMs: number; driftMs: number } {
  const driftMs = Math.abs((postB.offset - postA.offset) - (preB.offset - preA.offset));
  const width = Math.max(preA.width + preB.width, postA.width + postB.width);
  return { boundMs: Math.ceil(Math.max(width + driftMs, driftMs > 100 ? 251 : 0)), driftMs };
}

export function normalizeLogClock(log: string, deltaMs: number): string {
  return log.split(/\r?\n/).map((line) => {
    const match = /^(\S+Z)(\s.*)$/.exec(line);
    if (!match) return line;
    const at = Date.parse(match[1]!);
    return Number.isFinite(at) ? `${new Date(at + deltaMs).toISOString()}${match[2]}` : line;
  }).join("\n");
}

async function waitForWitness(spec: HostSpec, relative: string, expected: string, refOnly: boolean): Promise<boolean> {
  const script = refOnly
    ? `i=0; while test "$i" -lt 15; do test "$(git -C "$1" rev-parse HEAD 2>/dev/null)" = "$2" && { printf ok; exit; }; i=$((i+1)); sleep 1; done; exit 1\n`
    : `i=0; while test "$i" -lt 15; do test "$(cat "$1/$2" 2>/dev/null)" = "$3" && { printf ok; exit; }; i=$((i+1)); sleep 1; done; exit 1\n`;
  const args = refOnly ? [spec.workspace, expected] : [spec.workspace, relative, expected];
  return await onHost(spec, script, args, true) === "ok";
}

async function logs(spec: HostSpec): Promise<string> {
  return onHost(spec, `NO_COLOR=1 TERM=dumb rbox logs "$1" --limit 10000\n`, [spec.workspace]);
}

async function main(): Promise<void> {
  const { sender, receivers, refOnly } = parseArgs(process.argv.slice(2));
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const relative = `${BENCH_DIR}/${id}.txt`;
  const content = `rbox propagation bench ${id}`;
  const classification: PropagationClassification = refOnly ? "git" : "file";
  await onHost(sender, refOnly
    ? `git -C "$1" rev-parse --is-inside-work-tree >/dev/null\n`
    : `mkdir -p "$1/${BENCH_DIR}"\n`, [sender.workspace]);
  const pre = await Promise.all([clockWindow(sender), ...receivers.map(clockWindow)]);
  const mutation = await onHost(sender, refOnly
    ? `set -e\nbun -e 'process.stdout.write(String(Date.now()))'; printf '\\n'\ngit -C "$1" -c user.name=rbox-bench -c user.email=bench@rbox.to commit --allow-empty -m "$2" >/dev/null\ngit -C "$1" rev-parse HEAD\n`
    : `set -e\nbun -e 'process.stdout.write(String(Date.now()))'; printf '\\n'\nprintf %s "$2" > "$1/$3"\n`,
  [sender.workspace, refOnly ? `rbox propagation bench ${id}` : content, relative]);
  const [writeText, result = ""] = mutation.trimEnd().split("\n");
  const writeAt = Number(writeText);
  if (!Number.isFinite(writeAt)) throw new Error(`${sender.host}: invalid write timestamp`);
  const expected = refOnly ? result.trim() : content;
  const matched = await Promise.all(receivers.map((receiver) => waitForWitness(receiver, relative, expected, refOnly)));
  await Bun.sleep(250);
  const [originLog, ...receiverLogs] = await Promise.all([logs(sender), ...receivers.map(logs)]);
  const post = await Promise.all([clockWindow(sender), ...receivers.map(clockWindow)]);
  let failed = false;
  for (let index = 0; index < receivers.length; index++) {
    const receiver = receivers[index]!;
    const skew = clockSkewBound(pre[0]!, post[0]!, pre[index + 1]!, post[index + 1]!);
    const receiverOffset = (pre[index + 1]!.offset + post[index + 1]!.offset) / 2;
    const senderOffset = (pre[0]!.offset + post[0]!.offset) / 2;
    const receiverLog = normalizeLogClock(receiverLogs[index]!, senderOffset - receiverOffset);
    const report = buildHopReport(originLog, receiverLog, {
      attempt: id,
      classification,
      writeAt,
      clockSkewBoundMs: skew.boundMs,
      witnessMatched: matched[index],
    });
    process.stdout.write(`sender=${sender.host} receiver=${receiver.host} clock_skew_bound_ms=${skew.boundMs} drift_ms=${Math.round(skew.driftMs * 10) / 10}\n`);
    process.stdout.write(renderHopReport(report));
    failed ||= report.verdict !== "PASS";
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.main) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
