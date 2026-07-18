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
  /** Replace the live label (e.g. progress). On a TTY the next frame shows it; on
   *  a non-TTY it prints a fresh line, but throttled so a long operation emits a
   *  few liveness lines rather than thousands (an agent/CI sees it's not hung). */
  update(label: string): void;
  /** Show one dim reassurance note after this spinner has been running for the
   *  default 10 seconds. Repeated calls update the pending note, but it renders
   *  at most once. */
  slowNote(message: string, afterMs?: number): void;
  succeed(message?: string): void;
  fail(message?: string): void;
  stop(): void;
}

export function spinner(initial: string): Spinner {
  const out = process.stderr;
  let label = initial;
  const startedAt = Date.now();
  let slowNoteShown = false;
  let slowNoteTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSlowNote: string | undefined;
  let showSlowNote: ((message: string) => void) | undefined;
  const scheduleSlowNote = (message: string, afterMs = 10_000): void => {
    if (slowNoteShown) return;
    pendingSlowNote = message;
    if (slowNoteTimer) return;
    const show = () => {
      slowNoteShown = true;
      slowNoteTimer = undefined;
      if (pendingSlowNote) showSlowNote?.(pendingSlowNote);
    };
    const remaining = afterMs - (Date.now() - startedAt);
    if (remaining <= 0) show();
    else {
      slowNoteTimer = setTimeout(show, remaining);
      slowNoteTimer.unref?.();
    }
  };
  const cancelSlowNote = (): void => {
    if (slowNoteTimer) clearTimeout(slowNoteTimer);
    slowNoteTimer = undefined;
    pendingSlowNote = undefined;
  };
  if (out.isTTY !== true || process.env.NO_COLOR) {
    out.write(`${label}…\n`);
    let lastPrint = Date.now();
    showSlowNote = (message) => out.write(`  ${stderrStyle.dim(message)}\n`);
    return {
      update: (l) => {
        label = l;
        const now = Date.now();
        if (now - lastPrint >= 1000) {
          lastPrint = now;
          out.write(`  ${label}\n`);
        }
      },
      slowNote: scheduleSlowNote,
      succeed: (m) => { cancelSlowNote(); out.write(`${stderrStyle.sym.ok} ${m ?? label}\n`); },
      fail: (m) => { cancelSlowNote(); out.write(`${stderrStyle.sym.err} ${m ?? label}\n`); },
      stop: cancelSlowNote,
    };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const id = setInterval(() => out.write(`\r\x1b[K${stderrStyle.cyan(frames[i++ % frames.length]!)} ${label} `), 80);
  if (typeof id.unref === "function") id.unref();
  showSlowNote = (message) => out.write(`\r\x1b[K  ${stderrStyle.dim(message)}\n`);
  const end = (sigil: string, m?: string): void => {
    clearInterval(id);
    cancelSlowNote();
    out.write(`\r\x1b[K${sigil} ${m ?? label}\n`); // \x1b[K clears the spinner remnants on the line
  };
  return {
    update: (l) => {
      label = l;
    },
    slowNote: scheduleSlowNote,
    succeed: (m) => end(stderrStyle.sym.ok, m),
    fail: (m) => end(stderrStyle.sym.err, m),
    // Clear the half-drawn frame too — callers that stop() then print their own
    // summary (pull/sync) must not leave a stale spinner remnant on the line.
    stop: () => {
      clearInterval(id);
      cancelSlowNote();
      out.write("\r\x1b[K");
    },
  };
}
