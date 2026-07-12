const MAX_LATENCY_MS = 10 * 60 * 1_000;

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

function timestamped(line: string): { at: number; text: string } | undefined {
  const match = /^(\S+Z)\s+(.*)$/.exec(line);
  if (!match) return;
  const at = Date.parse(match[1]!);
  if (!Number.isFinite(at)) return;
  return { at, text: match[2]! };
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
    if (/\bpull applied:/.test(parsed.text)) {
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
  const { originPath, receiverPath, sinceHours } = parseArgs(Bun.argv.slice(2));
  const [originLog, receiverLog] = await Promise.all([Bun.file(originPath).text(), Bun.file(receiverPath).text()]);
  process.stdout.write(renderReport(buildReport(originLog, receiverLog, { sinceHours })));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
