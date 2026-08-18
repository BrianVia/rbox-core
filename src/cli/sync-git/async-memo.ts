/** One-shot async memo with explicit invalidation.
 *
 * Never: repository policy, I/O, or cross-key cache ownership.
 */
export function asyncMemo<T>(fn: () => Promise<T>): (() => Promise<T>) & { reset: () => void } {
  let done = false;
  let value: T;
  const get = async (): Promise<T> => {
    if (!done) {
      value = await fn();
      done = true;
    }
    return value;
  };
  return Object.assign(get, {
    reset: () => {
      done = false;
    },
  });
}
