/** One-shot async memo with explicit invalidation. */
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
