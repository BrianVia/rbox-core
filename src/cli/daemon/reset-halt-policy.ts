/** How long a terminal reset halt (W2/W3/J0 and every non-recoverable reason)
 * waits before retrying. Fail-closed conditions need an operator, so retrying
 * sooner only fills the log. */
export const RESET_RECOVERY_RETRY_MS = 60 * 60 * 1000;

/** Design 276 F2.3. A W1 writer takeover that loses a race with a foreign
 * reader ("reset checkpoint remained busy") is transient: the reader detaches in
 * seconds, not hours. These bound the re-inspection retries that precede any
 * escalation to the hourly halt above. Six attempts five seconds apart covers a
 * half-minute of foreign attachment — long enough for an interactive
 * `sqlite3 file:...?mode=ro` session's statement, short enough that a genuinely
 * stuck store still reaches its fail-closed halt promptly. Each attempt is one
 * classifier pass plus one checkpoint, so the whole episode is cheap.
 * Deletion condition: the classifier gains cross-process ownership input. */
export const RESET_WAL_CRASH_RETRY_MS = 5_000;
export const RESET_WAL_CRASH_RETRY_ATTEMPTS = 6;

/** The halt log gate's own interval. Split from RESET_RECOVERY_RETRY_MS (design
 * 276 F2.3) so a shorter retry deadline can never shorten log suppression. */
export const RESET_HALT_LOG_INTERVAL_MS = 60 * 60 * 1000;

const DEFAULT_LRU_CAPACITY = 64;

/** Bounded, per-distinct-message hourly log gate. Refreshing a key moves it to
 * the MRU edge, so alternating failures cannot evade suppression and novel
 * corrupt inputs cannot grow daemon memory without bound. */
export class ResetHaltLogGate {
  private readonly loggedAt = new Map<string, number>();

  constructor(
    private readonly intervalMs = RESET_HALT_LOG_INTERVAL_MS,
    private readonly capacity = DEFAULT_LRU_CAPACITY,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) throw new Error("reset halt log interval must be non-negative");
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("reset halt log capacity must be positive");
  }

  shouldLog(message: string, now: number): boolean {
    const previous = this.loggedAt.get(message);
    if (previous !== undefined) {
      this.loggedAt.delete(message);
      this.loggedAt.set(message, previous);
      if (now - previous < this.intervalMs) return false;
      this.loggedAt.delete(message);
    }
    this.loggedAt.set(message, now);
    while (this.loggedAt.size > this.capacity) {
      const oldest = this.loggedAt.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.loggedAt.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.loggedAt.size;
  }
}
