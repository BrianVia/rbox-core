/** Per-owner serialized task queue. Worker intake close, registration, result
 *  application/discard, lease release, pending decrement, abort, and publish all
 *  execute here, so no two of them can interleave. Abort deliberately YIELDS the
 *  queue before waiting, so a worker return callback can reenter it. */
export class SerializedQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
