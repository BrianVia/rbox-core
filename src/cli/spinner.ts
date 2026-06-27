/**
 * Zero-dependency, TTY-aware spinner (design 07c).
 *
 * Writes to STDERR so animation frames never pollute stdout — a piped
 * `rbox push` keeps a clean summary on stdout. On a non-TTY (CI, redirected
 * stderr) it degrades to a single plain line with the same API, so logs never
 * fill with carriage returns. The interval is unref'd so it can't keep the
 * process alive on its own.
 */
import { stderrStyle } from "./style.js";

export interface Spinner {
  succeed(message?: string): void;
  fail(message?: string): void;
  stop(): void;
}

export function spinner(label: string): Spinner {
  const out = process.stderr;
  if (out.isTTY !== true || process.env.NO_COLOR) {
    out.write(`${label}…\n`);
    return {
      succeed: (m) => out.write(`${stderrStyle.sym.ok} ${m ?? label}\n`),
      fail: (m) => out.write(`${stderrStyle.sym.err} ${m ?? label}\n`),
      stop: () => {},
    };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const id = setInterval(() => out.write(`\r${stderrStyle.cyan(frames[i++ % frames.length]!)} ${label} `), 80);
  if (typeof id.unref === "function") id.unref();
  const end = (sigil: string, m?: string): void => {
    clearInterval(id);
    out.write(`\r\x1b[K${sigil} ${m ?? label}\n`); // \x1b[K clears the spinner remnants on the line
  };
  return {
    succeed: (m) => end(stderrStyle.sym.ok, m),
    fail: (m) => end(stderrStyle.sym.err, m),
    // Clear the half-drawn frame too — callers that stop() then print their own
    // summary (pull/sync) must not leave a stale spinner remnant on the line.
    stop: () => {
      clearInterval(id);
      out.write("\r\x1b[K");
    },
  };
}
