import type { FileEntry } from "../../engine/index.js";
import { ResourceBudget } from "./budget.js";

export type Disposition = "uploaded" | "satisfied-skip" | "duplicate-skip" | "abandoned";

export interface ReadyBlob {
  file: FileEntry;
  encSha: string;
  cipherSize: number;
  path: string;
  diskCharge: number;
  release(disposition: Disposition): void;
}

export const EOF = Symbol("ready-queue-eof");
export type EOF = typeof EOF;

type PullWaiter = { resolve: (item: ReadyBlob | EOF) => void; reject: (error: Error) => void };

export interface ReadyQueueOptions {
  maxItems?: number;
  items?: ResourceBudget;
  heap?: ResourceBudget;
}

export class ReadyQueue {
  private readonly items: ResourceBudget;
  private readonly heap: ResourceBudget | undefined;
  private readonly queued: ReadyBlob[] = [];
  private readonly pulls: PullWaiter[] = [];
  private writingClosed = false;
  private aborted: Error | undefined;

  constructor(options: ReadyQueueOptions = {}) {
    this.items = options.items ?? new ResourceBudget(options.maxItems ?? 2_048);
    this.heap = options.heap;
  }

  async push(item: ReadyBlob): Promise<void> {
    if (this.aborted) throw this.aborted;
    if (this.writingClosed) throw new Error("ready queue is closed for writing");
    await this.items.reserve(1);
    try {
      await this.heap?.reserve(item.cipherSize);
    } catch (error) {
      this.items.release(1);
      throw error;
    }
    if (this.aborted || this.writingClosed) {
      this.items.release(1);
      this.heap?.release(item.cipherSize);
      throw this.aborted ?? new Error("ready queue is closed for writing");
    }
    const pull = this.pulls.shift();
    if (pull) {
      this.releaseAxes(item);
      pull.resolve(item);
    } else {
      this.queued.push(item);
    }
  }

  pull(): Promise<ReadyBlob | EOF> {
    if (this.aborted) return Promise.reject(this.aborted);
    const item = this.queued.shift();
    if (item) {
      this.releaseAxes(item);
      return Promise.resolve(item);
    }
    if (this.writingClosed) return Promise.resolve(EOF);
    return new Promise<ReadyBlob | EOF>((resolve, reject) => this.pulls.push({ resolve, reject }));
  }

  closeForWriting(): void {
    if (this.writingClosed || this.aborted) return;
    this.writingClosed = true;
    const error = new Error("ready queue is closed for writing");
    this.items.close(error);
    this.heap?.close(error);
    if (this.queued.length === 0) for (const pull of this.pulls.splice(0)) pull.resolve(EOF);
  }

  abort(err: Error): void {
    if (this.aborted) return;
    this.aborted = err;
    this.writingClosed = true;
    this.items.close(err);
    this.heap?.close(err);
    for (const pull of this.pulls.splice(0)) pull.reject(err);
    for (const item of this.queued.splice(0)) this.releaseAxes(item);
  }

  private releaseAxes(item: ReadyBlob): void {
    this.items.release(1);
    this.heap?.release(item.cipherSize);
    if (this.writingClosed && this.queued.length === 0) {
      for (const pull of this.pulls.splice(0)) pull.resolve(EOF);
    }
  }
}
