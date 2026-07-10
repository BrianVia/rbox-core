import { spawn, type SpawnOptions } from "node:child_process";
import * as readline from "node:readline";

/**
 * Cross-platform, TTY-aware, never-throws browser + clipboard helpers, shared by
 * `subscribe-cmd.ts` (billing checkout/portal handoff) and `auth-cmd.ts` (browser
 * login). Extracted out of `subscribe-cmd.ts` so the spawn plumbing lives in one
 * place instead of being duplicated per call site.
 *
 * The spawn is behind an injectable seam (`_setSpawner`) — matching this codebase's
 * house style of testing side-effecting child_process work through a seam rather
 * than a process-global module mock (see the daemon watcher tests) — so a test can
 * assert the exact command/args per platform without launching a real process.
 */

/** The slice of `child_process`'s child this module touches. Kept minimal so the
 *  test double is trivial. */
interface ChildLike {
  on(event: "error", listener: (err?: unknown) => void): unknown;
  unref(): unknown;
  stdin?: { write(chunk: string): unknown; end(): unknown } | null;
}
type Spawner = (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildLike;

const realSpawner: Spawner = (cmd, args, opts) => spawn(cmd, [...args], opts);
let spawner: Spawner = realSpawner;

/** TEST-ONLY seam: swap the spawner (pass nothing to restore the real one). */
export function _setSpawner(fn?: Spawner): void {
  spawner = fn ?? realSpawner;
}

/** Open a URL in the user's browser, cross-platform. Returns false (so the caller
 *  prints the URL) when there's no opener or we're not on a TTY — never blocks. */
export function openInBrowser(url: string): boolean {
  if (!process.stdout.isTTY) return false; // CI / piped → just print the URL
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawner(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // a missing opener rejects async — handled by the printed fallback
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Open `url` (or fall back to printing it), with the verb-appropriate message. */
export function openAndShow(url: string, opening: string, fallback: string): void {
  console.log(`${openInBrowser(url) ? opening : fallback}\n  ${url}`);
}

/** Copy `text` to the OS clipboard, cross-platform, best-effort. Returns false when
 *  no clipboard utility is available — never throws, never blocks. Mirrors
 *  `openInBrowser`'s "couldn't do it → let the caller print it" contract. Spawns the
 *  platform's clipboard reader and feeds `text` on stdin (`pbcopy` / `clip` /
 *  `xclip` / `xsel`); a missing binary rejects async and is swallowed, so the caller
 *  should still show the raw URL as a fallback path. */
export function copyToClipboard(text: string): boolean {
  const candidates: Array<readonly [string, readonly string[]]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];
  for (const [cmd, args] of candidates) {
    try {
      const child = spawner(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => {}); // missing binary rejects async — swallow, caller prints the URL
      if (!child.stdin) continue; // no stdin to feed → try the next candidate
      child.stdin.write(text);
      child.stdin.end();
      return true;
    } catch {
      // synchronous spawn failure → try the next candidate (Linux xclip→xsel)
    }
  }
  return false;
}

/** Wait for a single raw keypress on stdin, resolving with its key name (e.g.
 *  `"c"`), or `undefined` immediately off a TTY. Raw mode suppresses the normal
 *  SIGINT that Ctrl-C would otherwise raise, so we re-raise it ourselves as
 *  `exit(130)` — the same convention `prompt.ts` uses for a cancelled widget.
 *  Restores stdin's prior raw-mode state before resolving; never throws. */
export function waitForKeypress(): Promise<string | undefined> {
  const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean; setRawMode?: (mode: boolean) => unknown };
  if (!stdin.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode?.(true);
    const onKeypress = (_str: string, key?: { name?: string; ctrl?: boolean }) => {
      stdin.removeListener("keypress", onKeypress);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
      if (key?.ctrl && key.name === "c") {
        process.exit(130);
        return;
      }
      resolve(key?.name);
    };
    stdin.once("keypress", onKeypress);
  });
}
