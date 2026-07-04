/** Stable JSON stdout emitter for `--json` CLI surfaces. */
export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
