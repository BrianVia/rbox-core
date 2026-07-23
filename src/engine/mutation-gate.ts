export type MutationPhase = "file-apply" | "git-prepare" | "git-commit" | "state-cas";

export interface MutationDescriptor {
  phase: MutationPhase;
  repository?: string;
}

export interface ActiveMutation extends MutationDescriptor {
  id: number;
  committed: boolean;
}

export class MutationGateClosedError extends Error {
  constructor() {
    super("daemon shutdown began before mutation boundary");
    this.name = "MutationGateClosedError";
  }
}

export interface MutationLease {
  readonly abortRequested: boolean;
  /** Atomically cross the irreversible boundary. False means shutdown won and
   * the prepared operation must abort. */
  beginCommit(phase?: MutationPhase): boolean;
  finish(): void;
}

export interface MutationBoundary {
  enter(descriptor: MutationDescriptor): MutationLease;
}

/** Process-local synchronous shutdown gate plus mutation registry. JavaScript
 * run-to-completion makes close-vs-enter and close-vs-beginCommit atomic. */
export class ShutdownMutationGate implements MutationBoundary {
  private stopping = false;
  private nextId = 1;
  private readonly active = new Map<number, ActiveMutation>();
  private drainWaiters: Array<() => void> = [];
  private committedDrainWaiters: Array<() => void> = [];

  constructor(private readonly onChange: () => void = () => {}) {}

  get closed(): boolean { return this.stopping; }

  close(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.onChange();
    this.resolveCommittedDrain();
    this.resolveDrain();
  }

  enter(descriptor: MutationDescriptor): MutationLease {
    if (this.stopping) throw new MutationGateClosedError();
    const id = this.nextId++;
    const active: ActiveMutation = { ...descriptor, id, committed: false };
    this.active.set(id, active);
    let finished = false;
    const thisGate = this;
    return {
      get abortRequested() { return !active.committed && thisGate.stopping; },
      beginCommit: (phase) => {
        if (active.committed) return true;
        if (this.stopping) return false;
        active.committed = true;
        if (phase !== undefined) active.phase = phase;
        return true;
      },
      finish: () => {
        if (finished) return;
        finished = true;
        this.active.delete(id);
        // Ordinary sync enters and leaves many short leases. Ambient shutdown
        // status only needs registry changes after close(), when those changes
        // describe the drain and can affect stop's critical-section witness.
        if (this.stopping) this.onChange();
        this.resolveCommittedDrain();
        this.resolveDrain();
      },
    };
  }

  snapshot(): readonly ActiveMutation[] {
    return [...this.active.values()].map((item) => ({ ...item }));
  }

  async drain(): Promise<void> {
    if (this.active.size === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  /** Await only irreversible work after close(). Prepared leases are abortable
   * and must not suppress the daemon's ordinary shutdown deadline. */
  async drainCommitted(): Promise<void> {
    if (![...this.active.values()].some((mutation) => mutation.committed)) return;
    await new Promise<void>((resolve) => this.committedDrainWaiters.push(resolve));
  }

  private resolveCommittedDrain(): void {
    if ([...this.active.values()].some((mutation) => mutation.committed)) return;
    const waiters = this.committedDrainWaiters;
    this.committedDrainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private resolveDrain(): void {
    if (this.active.size !== 0) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
