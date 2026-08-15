import type { JsonValue } from "../../json.js";

/**
 * Defensive reader for numbers-only server timing objects (design 97 / 101).
 * Returns the named fields iff EVERY key is a finite, non-negative number —
 * otherwise `undefined`, so a client on an old server (absent field) or a
 * partial/garbled payload degrades to "no server timings" rather than throwing.
 * Extra keys are ignored (additive server evolution stays safe).
 */
export function readNumericFields<K extends string>(value: JsonValue | undefined, keys: readonly K[]): Record<K, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const key of keys) {
    const n = value[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Record<K, number>;
}
