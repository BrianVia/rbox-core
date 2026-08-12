const MAX_LATENCY_MS = 10 * 60 * 1_000;
const SENDER_CLOCK_GUARD_MS = 250;
export const PROPAGATION_BUDGET_MS = 10_000;

type Publish = { at: number; sequence: number };
type Apply = { at: number; sequence?: number; id: number };
type Hour = { hour: number; publishes: number; matched: number; unmatched: number };

export type PropagationReport = {
  publishes: number;
  matched: number;
  unmatched: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  batched: boolean;
  hours: Hour[];
};

export type PropagationClassification = "file" | "git";
export type HopCorrelation = "exact" | "coalesced" | "unmatched" | "invalid-clock-skew";

export interface HopReport {
  attempt: string;
  classification: PropagationClassification;
  sequence?: number;
  correlation: HopCorrelation;
  clockSkewBoundMs: number;
  witnessMatched: boolean;
  budgetMs: number;
  verdict: "PASS" | "FAIL" | "INVALID";
  stamps: {
    write?: number;
    batcherSettle?: number;
    pushBegin?: number;
    publishReceipt?: number;
    wsReceipt?: number;
    pullDequeue?: number;
    applyComplete?: number;
  };
}

function timestamped(line: string): { at: number; text: string } | undefined {
  const match = /^(\S+Z)\s+(.*)$/.exec(line);
  if (!match) return;
  const at = Date.parse(match[1]!);
  if (!Number.isFinite(at)) return;
  return { at, text: match[2]! };
}

function jsonAfter<T>(text: string, prefix: string): T | undefined {
  if (!text.startsWith(prefix)) return;
  try { return JSON.parse(text.slice(prefix.length)) as T; } catch { return; }
}

type SenderTrace = {
  at: number;
  line: string;
  sequence: number;
  ms: Partial<Record<"file_fired" | "git_fired" | "begin" | "receipt", number>>;
};

type ReceiverStamp = { at: number; event: "ws_committed" | "pull_dequeue" | "apply_complete"; sequence: number };

function receiverChain(receiver: ReceiverStamp[], sequence: number): {
  wsReceipt?: ReceiverStamp;
  dequeue?: ReceiverStamp;
  apply?: ReceiverStamp;
} {
  const ws = receiver.filter((stamp) => stamp.event === "ws_committed" && stamp.sequence === sequence);
  const wsReceipt = ws.length === 1 ? ws[0] : undefined;
  const dequeue = wsReceipt
    ? receiver.find((stamp) => stamp.event === "pull_dequeue" && stamp.sequence >= sequence && stamp.at >= wsReceipt.at)
    : undefined;
  const apply = dequeue
    ? receiver.find((stamp) => stamp.event === "apply_complete" && stamp.sequence >= sequence && stamp.at >= dequeue.at)
    : undefined;
  return { wsReceipt, dequeue, apply };
}

function senderTraces(log: string): SenderTrace[] {
  const traces: SenderTrace[] = [];
  for (const line of log.split(/\r?\n/)) {
    const parsed = timestamped(line);
    if (!parsed) continue;
    const body = jsonAfter<{ sequence?: unknown; ms?: SenderTrace["ms"] }>(parsed.text, "propagation_trace ");
    if (!body || !Number.isSafeInteger(body.sequence) || !body.ms || !Number.isFinite(body.ms.receipt)) continue;
    traces.push({ at: parsed.at, line, sequence: body.sequence as number, ms: body.ms });
  }
  return traces;
}

/** Select the causally attributable cycle for an attempt. The first receipt after
 * the write fixes the published sequence; later cycles may describe that same
 * publication, but neighboring publications may not steal the attempt. */
export function senderTraceForAttempt(
  log: string,
  classification: PropagationClassification,
  writeAt: number,
): string | undefined {
  const traces = senderTraces(log);
  const firstPublished = traces
    .filter((trace) => trace.at >= writeAt)
    .sort((a, b) => a.at - b.at)[0];
  if (!firstPublished) return;
  const settleKey = `${classification}_fired` as const;
  const candidates = traces.flatMap((trace) => {
    const settleOffset = trace.ms[settleKey];
    if (trace.at < writeAt || trace.sequence !== firstPublished.sequence || !Number.isFinite(settleOffset)) return [];
    const settleAt = trace.at - (trace.ms.receipt! - settleOffset!);
    return settleAt >= writeAt - SENDER_CLOCK_GUARD_MS ? [{ trace, settleAt }] : [];
  });
  candidates.sort((a, b) => {
    const aGuarded = a.settleAt < writeAt;
    const bGuarded = b.settleAt < writeAt;
    return Number(aGuarded) - Number(bGuarded) || a.settleAt - b.settleAt || a.trace.at - b.trace.at;
  });
  return candidates[0]?.trace.line;
}

function receiverStamps(log: string): ReceiverStamp[] {
  const stamps: ReceiverStamp[] = [];
  for (const line of log.split(/\r?\n/)) {
    const parsed = timestamped(line);
    if (!parsed) continue;
    const body = jsonAfter<{ event?: unknown; sequence?: unknown; adopted_sequence?: unknown }>(parsed.text, "propagation_receive ");
    if (!body || (body.event !== "ws_committed" && body.event !== "pull_dequeue" && body.event !== "apply_complete")) continue;
    const raw = body.event === "apply_complete" ? body.adopted_sequence : body.sequence;
    if (Number.isSafeInteger(raw)) stamps.push({ at: parsed.at, event: body.event, sequence: raw as number });
  }
  return stamps;
}

/** Build one fail-closed, sequence-joined attempt. Log timestamps are wall-clock stamps;
 * sender trace offsets reconstruct its earlier monotonic stages from receipt time. */
export function buildHopReport(
  originLog: string,
  receiverLog: string,
  options: {
    attempt: string;
    classification: PropagationClassification;
    writeAt: number;
    clockSkewBoundMs: number;
    witnessMatched?: boolean;
    budgetMs?: number;
  },
): HopReport {
  const budgetMs = options.budgetMs ?? PROPAGATION_BUDGET_MS;
  const settleKey = `${options.classification}_fired` as const;
  const selectedTrace = senderTraceForAttempt(originLog, options.classification, options.writeAt);
  const trace = selectedTrace ? senderTraces(selectedTrace)[0] : undefined;
  const receiver = receiverStamps(receiverLog);
  const stamps: HopReport["stamps"] = { write: options.writeAt };
  if (trace) {
    const receiptOffset = trace.ms.receipt!;
    const settleOffset = trace.ms[settleKey];
    if (Number.isFinite(settleOffset)) stamps.batcherSettle = trace.at - (receiptOffset - settleOffset!);
    if (Number.isFinite(trace.ms.begin)) stamps.pushBegin = trace.at - (receiptOffset - trace.ms.begin!);
    stamps.publishReceipt = trace.at;
  }
  const { wsReceipt, dequeue, apply } = trace
    ? receiverChain(receiver, trace.sequence)
    : {};
  if (wsReceipt) stamps.wsReceipt = wsReceipt.at;
  if (dequeue) stamps.pullDequeue = dequeue.at;
  if (apply) stamps.applyComplete = apply.at;

  // The committed WS frame can reach either device before the publisher's HTTP call
  // returns. Sequence is the cross-host join; ordering is meaningful only within each
  // host's lane (plus both lanes beginning after the witnessed write).
  const senderOrdered = stamps.write !== undefined
    && stamps.batcherSettle !== undefined
    && stamps.pushBegin !== undefined
    && stamps.publishReceipt !== undefined
    && stamps.write <= stamps.batcherSettle
    && stamps.batcherSettle <= stamps.pushBegin
    && stamps.pushBegin <= stamps.publishReceipt;
  const receiverOrdered = stamps.write !== undefined
    && stamps.wsReceipt !== undefined
    && stamps.pullDequeue !== undefined
    && stamps.applyComplete !== undefined
    && stamps.write <= stamps.wsReceipt
    && stamps.wsReceipt <= stamps.pullDequeue
    && stamps.pullDequeue <= stamps.applyComplete;
  const completeAndOrdered = senderOrdered && receiverOrdered;
  const witnessMatched = options.witnessMatched ?? true;
  let correlation: HopCorrelation = "unmatched";
  if (completeAndOrdered && witnessMatched && trace && apply) {
    correlation = apply.sequence === trace.sequence ? "exact" : "coalesced";
    if (options.clockSkewBoundMs > 250) correlation = "invalid-clock-skew";
  }
  const elapsed = stamps.applyComplete === undefined ? Infinity : stamps.applyComplete - options.writeAt;
  const verdict = correlation === "exact" ? (elapsed <= budgetMs ? "PASS" : "FAIL") : "INVALID";
  return {
    attempt: options.attempt,
    classification: options.classification,
    ...(trace ? { sequence: trace.sequence } : {}),
    correlation,
    clockSkewBoundMs: options.clockSkewBoundMs,
    witnessMatched,
    budgetMs,
    verdict,
    stamps,
  };
}

export function renderHopReport(report: HopReport): string {
  const rows: Array<[string, number | undefined, number | undefined]> = [
    ["write → batcher settle", report.stamps.write, report.stamps.batcherSettle],
    ["batcher settle → push begin", report.stamps.batcherSettle, report.stamps.pushBegin],
    ["push begin → publish receipt", report.stamps.pushBegin, report.stamps.publishReceipt],
    ["write → matching WS receipt", report.stamps.write, report.stamps.wsReceipt],
    ["matching WS receipt → pull dequeue", report.stamps.wsReceipt, report.stamps.pullDequeue],
    ["pull dequeue → apply complete", report.stamps.pullDequeue, report.stamps.applyComplete],
    ["END TO END", report.stamps.write, report.stamps.applyComplete],
  ];
  const lines = [
    `propagation attempt=${report.attempt} class=${report.classification} sequence=${report.sequence ?? "-"} correlation=${report.correlation}`,
    `clock_skew_bound_ms ${report.clockSkewBoundMs}`,
    "| hop | from (UTC) | to (UTC) | ms |",
    "| --- | --- | --- | ---: |",
    ...rows.map(([label, from, to]) => `| ${label} | ${from === undefined ? "-" : new Date(from).toISOString()} | ${to === undefined ? "-" : new Date(to).toISOString()} | ${from === undefined || to === undefined ? "-" : Math.max(0, Math.round((to - from) * 10) / 10)} |`),
    `budget <=${report.budgetMs}ms ${report.verdict}`,
  ];
  return `${lines.join("\n")}\n`;
}

function sequenceFromReceiver(text: string): number | undefined {
  if (!/(?:\bremote:\s*seq(?:uence)?\b|\b(?:pull|status)\b.*\bseq(?:uence)?\b)/i.test(text)) return;
  const match = /\bseq(?:uence)?\s*[=:]?\s*(\d+)\b/i.exec(text);
  if (!match) return;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}

export function parseOrigin(log: string): Publish[] {
  const events: Publish[] = [];
  for (const line of log.split(/\r?\n/)) {
    const parsed = timestamped(line);
    if (!parsed) continue;
    const match = /\bpush: published sequence (\d+)\b/.exec(parsed.text);
    const sequence = match ? Number(match[1]) : NaN;
    if (Number.isSafeInteger(sequence)) events.push({ at: parsed.at, sequence });
  }
  return events;
}

export function parseReceiver(log: string): Apply[] {
  const events: Apply[] = [];
  let pendingSequence: number | undefined;
  for (const line of log.split(/\r?\n/)) {
    const parsed = timestamped(line);
    if (!parsed) continue;
    const observedSequence = sequenceFromReceiver(parsed.text);
    if (/\bpull apply complete ADOPTED sequence\b/i.test(parsed.text)) {
      events.push({ at: parsed.at, sequence: observedSequence, id: events.length });
      pendingSequence = undefined;
    } else if (/\bpull applied:/.test(parsed.text)) {
      events.push({ at: parsed.at, sequence: observedSequence ?? pendingSequence, id: events.length });
      pendingSequence = undefined;
    } else if (observedSequence !== undefined) {
      pendingSequence = observedSequence;
    }
  }
  return events.sort((a, b) => a.at - b.at || a.id - b.id);
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(fraction * sorted.length) - 1]!;
}

export function buildReport(originLog: string, receiverLog: string, options: { sinceHours?: number; now?: number } = {}): PropagationReport {
  const cutoff = options.sinceHours === undefined
    ? -Infinity
    : (options.now ?? Date.now()) - options.sinceHours * 60 * 60 * 1_000;
  const publishes = parseOrigin(originLog).filter((event) => event.at >= cutoff);
  const applies = parseReceiver(receiverLog);
  const exact = new Map<number, Apply[]>();
  for (const apply of applies) {
    if (apply.sequence === undefined) continue;
    const list = exact.get(apply.sequence) ?? [];
    list.push(apply);
    exact.set(apply.sequence, list);
  }

  const latencies: number[] = [];
  const useCounts = new Map<number, number>();
  const hours = new Map<number, Hour>();
  for (const publish of publishes) {
    const hourAt = Math.floor(publish.at / 3_600_000) * 3_600_000;
    const hour = hours.get(hourAt) ?? { hour: hourAt, publishes: 0, matched: 0, unmatched: 0 };
    hour.publishes++;
    hours.set(hourAt, hour);

    const sequenceApplies = exact.get(publish.sequence);
    const pool = sequenceApplies && sequenceApplies.length > 0 ? sequenceApplies : applies;
    const apply = pool.find((candidate) => candidate.at > publish.at);
    const latency = apply ? apply.at - publish.at : Infinity;
    if (apply) useCounts.set(apply.id, (useCounts.get(apply.id) ?? 0) + 1);
    if (apply && latency <= MAX_LATENCY_MS) {
      latencies.push(latency);
      hour.matched++;
    } else {
      hour.unmatched++;
    }
  }

  latencies.sort((a, b) => a - b);
  return {
    publishes: publishes.length,
    matched: latencies.length,
    unmatched: publishes.length - latencies.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    maxMs: latencies.at(-1) ?? 0,
    batched: [...useCounts.values()].some((count) => count > 1),
    hours: [...hours.values()].sort((a, b) => a.hour - b.hour),
  };
}

export function renderReport(report: PropagationReport): string {
  const lines = [
    `publishes ${report.publishes}`,
    `matched ${report.matched}`,
    `unmatched ${report.unmatched}`,
    `p50_ms ${report.p50Ms}`,
    `p95_ms ${report.p95Ms}`,
    `max_ms ${report.maxMs}`,
    `batched ${Number(report.batched)}`,
  ];
  for (const hour of report.hours) {
    lines.push(`hour ${new Date(hour.hour).toISOString()} publishes=${hour.publishes} matched=${hour.matched} unmatched=${hour.unmatched}`);
  }
  return `${lines.join("\n")}\n`;
}

function usage(): never {
  throw new Error("usage: bun scripts/propagation-report.ts <originLog> <receiverLog> [--sinceHours N]");
}

export function parseArgs(args: string[]): { originPath: string; receiverPath: string; sinceHours?: number } {
  if (args.length !== 2 && args.length !== 4) usage();
  const [originPath, receiverPath] = args;
  if (!originPath || !receiverPath) usage();
  if (args.length === 2) return { originPath, receiverPath };
  if (args[2] !== "--sinceHours") usage();
  const sinceHours = Number(args[3]);
  if (!Number.isFinite(sinceHours) || sinceHours < 0) usage();
  return { originPath, receiverPath, sinceHours };
}

async function main(): Promise<void> {
  const { originPath, receiverPath, sinceHours } = parseArgs(process.argv.slice(2));
  const [originLog, receiverLog] = await Promise.all([Bun.file(originPath).text(), Bun.file(receiverPath).text()]);
  process.stdout.write(renderReport(buildReport(originLog, receiverLog, { sinceHours })));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
