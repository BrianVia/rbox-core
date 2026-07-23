const marker = Symbol.for("rbox.prompt.ink-runtime-loaded");

export function markInkRuntimeLoaded(): void {
  (globalThis as Record<symbol, unknown>)[marker] = true;
}

export function inkRuntimeWasLoaded(): boolean {
  return (globalThis as Record<symbol, unknown>)[marker] === true;
}
