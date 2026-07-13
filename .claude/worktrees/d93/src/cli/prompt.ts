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
import { ExitPromptError } from "@inquirer/core";

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
