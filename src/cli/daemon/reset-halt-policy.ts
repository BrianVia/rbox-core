export const RESET_RECOVERY_RETRY_MS = 60 * 60 * 1000;
const DEFAULT_LRU_CAPACITY = 64;

/** Bounded, per-distinct-message hourly log gate. Refreshing a key moves it to
 * the MRU edge, so alternating failures cannot evade suppression and novel
 * corrupt inputs cannot grow daemon memory without bound. */
export class ResetHaltLogGate {
  private readonly loggedAt = new Map<string, number>();

  constructor(
    private readonly intervalMs = RESET_RECOVERY_RETRY_MS,
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
