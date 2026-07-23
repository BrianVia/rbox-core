import { emitJsonTo } from "./json.js";

/**
 * Zero-dependency ANSI styling for the rbox CLI.
 *
 * Rationale (design 07c): chalk's real value is its color-support detection,
 * which for our needs is a few lines — honor NO_COLOR / FORCE_COLOR and
 * `stream.isTTY`. A CLI invoked constantly (and a daemon we don't want paying
 * module-resolution tax) is better off without the dependency. The TTY/NO_COLOR
 * decision lives HERE, once — no scattered `\x1b[` literals anywhere else.
 *
 * Two surfaces: stdout styling (default) auto-disables when stdout is not a TTY
 * (so a piped `rbox status` stays clean); `stderrStyle` checks stderr for
 * diagnostics/spinners that write there.
 */
function colorEnabled(stream: NodeJS.WriteStream | undefined): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return stream?.isTTY === true;
}

type Styler = (s: string) => string;

function makeStyle(enabled: boolean): {
  bold: Styler; dim: Styler; red: Styler; green: Styler; yellow: Styler; cyan: Styler; gray: Styler;
  sym: { ok: string; warn: string; err: string; arrow: string; bullet: string };
} {
  const wrap = (open: number, close: number): Styler => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  const green = wrap(32, 39);
  const red = wrap(31, 39);
  const yellow = wrap(33, 39);
  const cyan = wrap(36, 39);
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red,
    green,
    yellow,
    cyan,
    gray: wrap(90, 39),
    sym: { ok: green("✓"), warn: yellow("!"), err: red("✗"), arrow: cyan("→"), bullet: cyan("•") },
  };
}

/** Styling for stdout (auto-disabled when stdout is piped or NO_COLOR is set). */
export const style = makeStyle(colorEnabled(process.stdout));
/** Styling for stderr (spinners, diagnostics). */
export const stderrStyle = makeStyle(colorEnabled(process.stderr));

/** Terminal lifecycle escape owned here with the rest of rbox's ANSI policy. */
export function ensureCursorVisible(stream: NodeJS.WritableStream = process.stderr): void {
  stream.write("\x1b[?25h");
}

let jsonErrorMode = false;

/** JSON errors are enabled only by the dispatcher for commands that declare `--json`. */
export function setJsonErrorMode(enabled: boolean): void {
  jsonErrorMode = enabled;
}

function emitError(message: string): void {
  if (jsonErrorMode) {
    emitJsonTo(process.stderr, { error: message });
    return;
  }
  process.stderr.write(`${stderrStyle.sym.err} ${stderrStyle.red(`rbox: ${message}`)}\n`);
}

/** Print a styled error to stderr and set a non-zero exit code (does not throw). */
export function fail(message: string): void {
  emitError(message);
  process.exitCode = 1;
}
