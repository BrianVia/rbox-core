import type { TransferProgressBytes } from "./transfer-progress.js";

export interface UploadByteOwner {
  path: string;
  encSha?: string;
}

const uint = (v: number): number => {
  if (!Number.isInteger(v) || v < 0) throw new Error(`invalid byte count: ${v}`);
  return v;
};

/**
 * Phase-local byte accounting for file uploads. The key property is file
 * ownership: a file may move from one encSha to another while the upload phase is
 * live, and the old key's numerator and denominator must be retracted once no
 * live file still references it.
 */
export class UploadByteTracker {
  private readonly fileToEnc = new Map<string, string>();
  private readonly refs = new Map<string, number>();
  private readonly planned = new Map<string, number>();
  private readonly completed = new Map<string, number>();
  private done = 0;
  private total = 0;

  static fromFiles(
    files: Iterable<UploadByteOwner>,
    missing: ReadonlySet<string>,
    plannedBytes: ReadonlyMap<string, number> = new Map()
  ): UploadByteTracker {
    const t = new UploadByteTracker();
    for (const f of files) {
      if (!f.encSha || !missing.has(f.encSha)) continue;
      t.addOwner(f.path, f.encSha, plannedBytes.get(f.encSha));
    }
    return t;
  }

  progress(): TransferProgressBytes {
    return { bytesDone: this.done, bytesTotal: this.total };
  }

  setProgress(encSha: string, absoluteBytesCompleted: number): void {
    const old = this.accounted(encSha);
    this.completed.set(encSha, uint(absoluteBytesCompleted));
    this.done += this.accounted(encSha) - old;
    this.assertInvariant();
  }

  reviseTotal(encSha: string, plannedBytes: number): void {
    if (!this.refs.has(encSha)) return;
    const oldAccounted = this.accounted(encSha);
    const oldPlanned = this.planned.get(encSha) ?? 0;
    const nextPlanned = uint(plannedBytes);
    this.planned.set(encSha, nextPlanned);
    this.total += nextPlanned - oldPlanned;
    this.done += this.accounted(encSha) - oldAccounted;
    this.assertInvariant();
  }

  migrate(path: string, nextEncSha: string | undefined, plannedBytes?: number): void {
    const prev = this.fileToEnc.get(path);
    if (prev === nextEncSha) {
      if (nextEncSha && plannedBytes !== undefined) this.reviseTotal(nextEncSha, plannedBytes);
      return;
    }
    if (prev) this.releaseOwner(path, prev);
    if (nextEncSha) this.addOwner(path, nextEncSha, plannedBytes);
    this.assertInvariant();
  }

  defer(path: string): void {
    this.migrate(path, undefined);
  }

  private addOwner(path: string, encSha: string, plannedBytes: number | undefined): void {
    this.fileToEnc.set(path, encSha);
    this.refs.set(encSha, (this.refs.get(encSha) ?? 0) + 1);
    if (plannedBytes !== undefined && !this.planned.has(encSha)) {
      const next = uint(plannedBytes);
      this.planned.set(encSha, next);
      this.total += next;
      this.done += this.accounted(encSha);
    }
    this.assertInvariant();
  }

  private releaseOwner(path: string, encSha: string): void {
    this.fileToEnc.delete(path);
    const nextRefs = (this.refs.get(encSha) ?? 0) - 1;
    if (nextRefs > 0) {
      this.refs.set(encSha, nextRefs);
      return;
    }
    this.refs.delete(encSha);
    const oldAccounted = this.accounted(encSha);
    const oldPlanned = this.planned.get(encSha) ?? 0;
    this.done -= oldAccounted;
    this.total -= oldPlanned;
    this.planned.delete(encSha);
    this.completed.delete(encSha);
    this.assertInvariant();
  }

  private accounted(encSha: string): number {
    const planned = this.planned.get(encSha);
    if (planned === undefined) return 0;
    return Math.min(this.completed.get(encSha) ?? 0, planned);
  }

  private assertInvariant(): void {
    if (this.done < 0 || this.total < 0 || this.done > this.total) {
      throw new Error(`upload byte invariant violated: ${this.done}/${this.total}`);
    }
  }
}
