const TOKEN_BYTES = 32;
const DEVICE_ID_BYTES = 16; // 128-bit device_id space → collisions are negligible (P1)

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** True when a D1/SQLite write failed a UNIQUE constraint (token_hash or device_id). */
export function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e));
}

/** True when the `accounts_cap_guard` trigger aborted a batch with RAISE(ABORT,'over_cap')
 *  — the over-quota signal every charge/grant path catches to roll back and 402. */
export function isOverCapAbort(e: unknown): boolean {
  return e instanceof Error && /over_cap/i.test(e.message);
}

export { TOKEN_BYTES, DEVICE_ID_BYTES };
