/**
 * The ONE place the rbox CLI talks to `@inquirer/prompts`.
 *
 * Two invariants ride on this being the sole importer of `@inquirer/prompts`
 * (enforced by a grep check in CI):
 *   1. STDERR — every widget renders on `process.stderr`, so `rbox setup > log`
 *      leaves stdout byte-clean. A single missed `output` on any call site would
 *      silently break that; routing every prompt through here makes it structural.
 *   2. Ctrl-C — inquirer throws `ExitPromptError` on SIGINT; we translate that to
 *      a clean `exit(130)` (the SIGINT convention the retired `readSecret` used)
 *      instead of letting an unhandled rejection print a stack trace.
 *
 * Signatures derive from inquirer's own config types (`Parameters<typeof …>[0]`),
 * so they track the pinned `^8.5` automatically. No custom theme — the surrounding
 * banners/summaries keep using `style.ts`; inquirer's default chrome (which already
 * honors FORCE_COLOR) renders the widgets.
 */
import { select, input, confirm, password, search } from "@inquirer/prompts";
import { ExitPromptError, createPrompt, isDownKey, isEnterKey, isTabKey, isUpKey, makeTheme, useKeypress, usePrefix, useState } from "@inquirer/core";
import path from "node:path";
import {
  DIRECTORY_PICKER_PAGE_SIZE,
  DirectoryListingCache,
  expandUserPath,
  highlightedAnswer,
  projectDirectoryPicker,
  tabRewrite,
  UnsupportedPathError,
  type DirectoryPickerOptions,
} from "./directory-picker.js";

export { expandUserPath, UnsupportedPathError } from "./directory-picker.js";

const STDERR = { output: process.stderr } as const;
const CANCEL_EXIT = 130; // SIGINT convention; matches the retired readSecret

/** Gate EVERY call site on this — inquirer requires a TTY (raw-mode stdin). */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}

async function run<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ExitPromptError) process.exit(CANCEL_EXIT);
    throw err;
  }
}

export const promptSelect = <V>(cfg: Parameters<typeof select<V>>[0]) => run(select<V>(cfg, STDERR));

/** A fire-and-forget `select` for the rare case where an EXTERNAL event can make the
 *  choice moot before the user answers — the browser-login flow shows this alongside
 *  its poll loop and cancels it the instant approval lands (design 47), so the prompt
 *  never blocks polling and never outlives the flow. `onChoice` runs only if the user
 *  actually picks; the returned `cancel()` aborts the widget (inquirer clears its
 *  line), and the abort/Ctrl-C rejections are handled here so nothing leaks as an
 *  unhandled rejection. A real SIGINT still exits 130, matching the awaited wrappers. */
export function cancelableSelect<V>(cfg: Parameters<typeof select<V>>[0], onChoice: (value: V) => void): { cancel: () => void } {
  const controller = new AbortController();
  select<V>(cfg, { ...STDERR, signal: controller.signal })
    .then(onChoice)
    .catch((err) => {
      if (err instanceof ExitPromptError) process.exit(CANCEL_EXIT);
      // AbortPromptError (external cancel()) or an already-settled abort → the flow
      // moved on without the user; nothing to do.
    });
  return { cancel: () => controller.abort() };
}
export const promptSearch = <V>(cfg: Parameters<typeof search<V>>[0]) => run(search<V>(cfg, STDERR));
export const promptInput = (cfg: Parameters<typeof input>[0]) => run(input(cfg, STDERR));
export const promptConfirm = (cfg: Parameters<typeof confirm>[0]) => run(confirm(cfg, STDERR));
/** mask:false = no echo, matching the old raw-mode readSecret (bearer secrets). */
export const promptPassword = (cfg: Parameters<typeof password>[0]) => run(password({ mask: false, ...cfg }, STDERR));

type PromptInput = typeof promptInput;

/** Prompt for an interactive path, resolving it against the caller's injected cwd. */
export async function promptPath(opts: {
  message: string;
  default?: string;
  cwd: string;
  /** Test/embedding seams; production callers use the shared prompt and stderr. */
  input?: PromptInput;
  writeStderr?: (text: string) => void;
}): Promise<string> {
  if (opts.input === undefined && isInteractive()) {
    return run(directoryPickerPrompt({
      message: opts.message,
      cwd: opts.cwd,
      ...(opts.default !== undefined ? { default: opts.default } : {}),
    }, STDERR));
  }

  const ask = opts.input ?? promptInput;
  const writeStderr = opts.writeStderr ?? ((text: string) => process.stderr.write(text));
  for (;;) {
    const raw = (await ask({ message: opts.message, ...(opts.default !== undefined ? { default: opts.default } : {}) })).trim();
    try {
      return path.resolve(opts.cwd, expandUserPath(raw));
    } catch (error) {
      if (!(error instanceof UnsupportedPathError)) throw error;
      writeStderr(`${error.message}\n`);
    }
  }
}

const pickerTheme = makeTheme();

/** Real synchronous typeahead prompt. Tests may invoke it with in-memory streams. */
export const directoryPickerPrompt = createPrompt<string, DirectoryPickerOptions>((config, done) => {
  const [status, setStatus] = useState<"idle" | "done">("idle");
  const [raw, setRaw] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [answer, setAnswer] = useState("");
  const [cache] = useState(() => config.cache ?? new DirectoryListingCache());
  const prefix = usePrefix({ status, theme: pickerTheme });
  const projection = projectDirectoryPicker(raw, config, cache);
  const visibleRows = projection.rows.slice(0, DIRECTORY_PICKER_PAGE_SIZE);

  useKeypress((key, rl) => {
    if (isEnterKey(key)) {
      const selected = highlightedAnswer(projection, highlight);
      if (selected === undefined) return;
      setAnswer(selected);
      setStatus("done");
      done(selected);
      return;
    }
    if (isTabKey(key)) {
      const rewritten = tabRewrite(projection, config.cwd);
      if (rewritten === undefined) return;
      rl.clearLine(0);
      rl.write(rewritten);
      setRaw(rewritten);
      setHighlight(0);
      return;
    }
    if (isUpKey(key) || isDownKey(key)) {
      if (visibleRows.length === 0) return;
      const offset = isUpKey(key) ? -1 : 1;
      setHighlight((highlight + offset + visibleRows.length) % visibleRows.length);
      return;
    }
    setRaw(rl.line);
    setHighlight(0);
  });

  const message = pickerTheme.style.message(config.message, status);
  if (status === "done") return [prefix, message, pickerTheme.style.answer(answer)].filter(Boolean).join(" ");

  const rowLines = visibleRows.map((row, index) => {
    const line = `${index === highlight ? "❯" : " "} ${row.label}`;
    return index === highlight ? pickerTheme.style.highlight(line) : line;
  });
  if (projection.notice) rowLines.push(pickerTheme.style.help(projection.notice));
  const hidden = projection.rows.length - visibleRows.length;
  if (hidden > 0) rowLines.push(pickerTheme.style.help(`+${hidden} more`));
  const hint = pickerTheme.style.help("Enter = this directory · type to filter · Tab completes");
  const body = [hint, ...rowLines].join("\n");
  return [[prefix, message, raw].filter((part) => part !== "").join(" "), body];
});
