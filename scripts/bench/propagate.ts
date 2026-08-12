#!/usr/bin/env bun
import { buildHopReport, renderHopReport, type HopReport, type PropagationClassification } from "../propagation-report.js";

const BENCH_DIR = "rbox-propagation-bench";
const SAMPLE_COUNT = 5;
const AUTHORITATIVE_SAMPLE_COUNT = 30;
export const WITNESS_POLL_DEADLINE_SECONDS = 180;

export interface HostSpec { host: string; workspace: string; local: boolean }
interface Sample { low: number; high: number; midpoint: number }
interface ClockWindow { offset: number; width: number }

function usage(): never {
  throw new Error("usage: bun scripts/bench/propagate.ts [--ref-only] [--attempts N] <LOCAL:/workspace|host:/workspace> <host:/workspace> [...]");
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

export function parseArgs(argv: string[]): { sender: HostSpec; receivers: HostSpec[]; refOnly: boolean; attempts: number } {
  let refOnly = false;
  let attempts = 1;
  const specs: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--ref-only") {
      if (refOnly) usage();
      refOnly = true;
    } else if (value === "--attempts") {
      const raw = argv[++index];
      if (!raw || !/^\d+$/.test(raw)) usage();
      attempts = Number(raw);
      if (!Number.isSafeInteger(attempts) || attempts < 1) usage();
    } else if (value.startsWith("--")) {
      usage();
    } else {
      specs.push(value);
    }
  }
  if (specs.length < 2) usage();
  return {
    sender: parseHostSpec(specs[0]!, true),
    receivers: specs.slice(1).map((value) => parseHostSpec(value, false)),
    refOnly,
    attempts,
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
    ? `i=0; while test "$i" -lt ${WITNESS_POLL_DEADLINE_SECONDS}; do test "$(git -C "$1" rev-parse HEAD 2>/dev/null)" = "$2" && { printf ok; exit; }; i=$((i+1)); sleep 1; done; exit 1\n`
    : `i=0; while test "$i" -lt ${WITNESS_POLL_DEADLINE_SECONDS}; do test "$(cat "$1/$2" 2>/dev/null)" = "$3" && { printf ok; exit; }; i=$((i+1)); sleep 1; done; exit 1\n`;
  const args = refOnly ? [spec.workspace, expected] : [spec.workspace, relative, expected];
  return await onHost(spec, script, args, true) === "ok";
}

async function logs(spec: HostSpec): Promise<string> {
  return onHost(spec, `NO_COLOR=1 TERM=dumb rbox logs "$1" --limit 10000\n`, [spec.workspace]);
}

function elapsedMs(report: HopReport): number | undefined {
  const { write, applyComplete } = report.stamps;
  return write === undefined || applyComplete === undefined ? undefined : applyComplete - write;
}

function measurementOutcome(report: HopReport): "WITHIN-BUDGET" | "OVER-BUDGET" | "INVALID" {
  return report.verdict === "PASS" ? "WITHIN-BUDGET" : report.verdict === "FAIL" ? "OVER-BUDGET" : "INVALID";
}

/** A single observation is evidence, never a statistical gate. */
export function renderMeasurement(report: HopReport): string {
  const verdictLine = `budget <=${report.budgetMs}ms ${report.verdict}\n`;
  const measurementLine = `budget <=${report.budgetMs}ms MEASUREMENT (n=1, non-authoritative) outcome=${measurementOutcome(report)}\n`;
  return renderHopReport(report).replace(verdictLine, measurementLine);
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

export function renderAttemptSummary(receiver: string, reports: HopReport[]): { text: string; failed: boolean } {
  const exact = reports.filter((report) => report.correlation === "exact");
  const latencies = exact.map(elapsedMs).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  const overBudget = exact.filter((report) => report.verdict === "FAIL").length;
  const coalesced = reports.filter((report) => report.correlation === "coalesced").length;
  const invalidClock = reports.filter((report) => report.correlation === "invalid-clock-skew").length;
  const unmatched = reports.length - exact.length - coalesced - invalidClock;
  const counts = `attempted=${reports.length} exact=${exact.length} coalesced=${coalesced} unmatched=${unmatched} invalid_clock=${invalidClock} over_budget=${overBudget}`;
  if (reports.length < AUTHORITATIVE_SAMPLE_COUNT) {
    return {
      text: `propagation summary receiver=${receiver} ${counts}\nbudget <=10000ms MEASUREMENT (n=${reports.length}, non-authoritative)\n`,
      failed: reports.some((report) => report.verdict === "INVALID"),
    };
  }
  if (exact.length < AUTHORITATIVE_SAMPLE_COUNT) {
    return {
      text: `propagation summary receiver=${receiver} ${counts}\nbudget <=10000ms INVALID (exact_n=${exact.length}, required=${AUTHORITATIVE_SAMPLE_COUNT})\n`,
      failed: true,
    };
  }
  const verdict = overBudget === 0 ? "PASS" : "OVER-BUDGET";
  return {
    text: `propagation summary receiver=${receiver} ${counts} p50_ms=${percentile(latencies, 0.5)} p95_ms=${percentile(latencies, 0.95)} max_ms=${latencies.at(-1) ?? 0}\nbudget <=10000ms ${verdict} (n=${exact.length}, authoritative)\n`,
    failed: overBudget > 0,
  };
}

async function main(): Promise<void> {
  const { sender, receivers, refOnly, attempts } = parseArgs(process.argv.slice(2));
  const classification: PropagationClassification = refOnly ? "git" : "file";
  await onHost(sender, refOnly
    ? `git -C "$1" rev-parse --is-inside-work-tree >/dev/null\n`
    : `mkdir -p "$1/${BENCH_DIR}"\n`, [sender.workspace]);
  const reportsByReceiver = receivers.map((): HopReport[] => []);
  let failed = false;
  for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex++) {
    const id = `${Date.now()}-${crypto.randomUUID()}`;
    const relative = `${BENCH_DIR}/${id}.txt`;
    const content = `rbox propagation bench ${id}`;
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
    for (let receiverIndex = 0; receiverIndex < receivers.length; receiverIndex++) {
      const receiver = receivers[receiverIndex]!;
      const skew = clockSkewBound(pre[0]!, post[0]!, pre[receiverIndex + 1]!, post[receiverIndex + 1]!);
      const receiverOffset = (pre[receiverIndex + 1]!.offset + post[receiverIndex + 1]!.offset) / 2;
      const senderOffset = (pre[0]!.offset + post[0]!.offset) / 2;
      const receiverLog = normalizeLogClock(receiverLogs[receiverIndex]!, senderOffset - receiverOffset);
      const report = buildHopReport(originLog, receiverLog, {
        attempt: id,
        classification,
        writeAt,
        clockSkewBoundMs: skew.boundMs,
        witnessMatched: matched[receiverIndex],
      });
      reportsByReceiver[receiverIndex]!.push(report);
      process.stdout.write(`attempt=${attemptIndex + 1}/${attempts} sender=${sender.host} receiver=${receiver.host} clock_skew_bound_ms=${skew.boundMs} drift_ms=${Math.round(skew.driftMs * 10) / 10}\n`);
      process.stdout.write(renderMeasurement(report));
    }
  }
  for (let index = 0; index < receivers.length; index++) {
    const summary = renderAttemptSummary(receivers[index]!.host, reportsByReceiver[index]!);
    process.stdout.write(summary.text);
    failed ||= summary.failed;
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.main) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
