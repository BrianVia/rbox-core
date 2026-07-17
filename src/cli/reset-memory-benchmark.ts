import { RESET_MATERIALIZED_BYTE_LIMIT, RESET_PARSE_EXPANSION_MULTIPLIER } from "./reset-io.js";

export const RESET_JSON_FLOOD_FAMILIES = ["arrays", "objects", "strings", "mixed"] as const;
export type ResetJsonFloodFamily = typeof RESET_JSON_FLOOD_FAMILIES[number];

function repeatToPayload(prefix: string, token: string, suffix: string, targetBytes: number): Buffer {
  if (targetBytes < Buffer.byteLength(prefix + suffix)) throw new RangeError("benchmark corpus target is too small");
  const bodyBytes = targetBytes - Buffer.byteLength(prefix + suffix);
  const count = Math.floor(bodyBytes / Buffer.byteLength(token));
  const padding = bodyBytes - count * Buffer.byteLength(token);
  // Whitespace is JSON grammar and lets every family hit the exact admitted
  // byte boundary without changing the allocation-heavy token population.
  return Buffer.from(prefix + token.repeat(count) + " ".repeat(padding) + suffix);
}

/** Arbitrary JSON reaches JSON.parse before schema validation. These are the
 * minimal-token allocation floods ratified by design 138, not state-schema
 * examples. Duplicate object keys are intentional: JSON admits them and the
 * parser must allocate/scan them even though the final value collapses. */
export function resetJsonFloodCorpus(family: ResetJsonFloodFamily, targetBytes: number): Buffer {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 64) throw new RangeError("invalid reset benchmark corpus size");
  switch (family) {
    case "arrays": return repeatToPayload("[", "0,", "0]", targetBytes);
    case "objects": return repeatToPayload("{", "\"\":0,", "\"_\":0}", targetBytes);
    case "strings": return Buffer.from(`"${"a".repeat(targetBytes - 2)}"`);
    case "mixed": return repeatToPayload("[", "{},[],\"\",0,", "null]", targetBytes);
  }
}

export function maximumResetParseAdmissionBytes(processBudgetBytes: number, currentRssBytes: number): number {
  const available = Math.max(0, processBudgetBytes - currentRssBytes);
  return Math.min(RESET_MATERIALIZED_BYTE_LIMIT, Math.floor(available / RESET_PARSE_EXPANSION_MULTIPLIER));
}

function maxRssBytes(): number {
  const value = process.resourceUsage().maxRSS;
  return process.platform === "darwin" ? value : value * 1024;
}

export interface ResetMemoryMeasurement {
  family: ResetJsonFloodFamily;
  inputBytes: number;
  peakGrowthBytes: number;
  multiplier: number;
}

export function measureResetJsonExpansion(family: ResetJsonFloodFamily, inputBytes: number): ResetMemoryMeasurement {
  const corpus = resetJsonFloodCorpus(family, inputBytes);
  (globalThis as unknown as { Bun?: { gc(force?: boolean): void } }).Bun?.gc(true);
  const beforeRss = process.memoryUsage.rss();
  const beforePeak = maxRssBytes();
  const parsed: unknown = JSON.parse(corpus.toString("utf8"));
  const afterRss = process.memoryUsage.rss();
  const afterPeak = maxRssBytes();
  // Keep the parse graph live until both counters have been sampled.
  if (parsed === undefined) throw new Error("benchmark parser returned undefined");
  const peakGrowthBytes = Math.max(0, afterRss - beforeRss, afterPeak - Math.max(beforePeak, beforeRss));
  return { family, inputBytes, peakGrowthBytes, multiplier: peakGrowthBytes / inputBytes };
}

if (import.meta.main) {
  const [mode, familyRaw, bytesRaw] = process.argv.slice(2);
  if (mode !== "--child" || !RESET_JSON_FLOOD_FAMILIES.includes(familyRaw as ResetJsonFloodFamily)) {
    throw new Error("usage: reset-memory-benchmark.ts --child <arrays|objects|strings|mixed> <bytes>");
  }
  const measurement = measureResetJsonExpansion(familyRaw as ResetJsonFloodFamily, Number(bytesRaw));
  process.stdout.write(`${JSON.stringify(measurement)}\n`);
}
