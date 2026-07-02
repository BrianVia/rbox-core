/**
 * Back-compat aliases (design 29 §"Back-compat & migration"). Renamed commands keep
 * a hidden alias for one deprecation window (until v0.3): the alias does the exact
 * same work, then prints a one-line notice to STDERR — never stdout, so a piped
 * `rbox link | …` is byte-for-byte unaffected. (`detect` was this kind of alias too,
 * before `deps` — and `detect` with it — was commented out; design 50.)
 *
 * Every alias is the SAME operation: rewrite `(cmd, positional)` into the canonical
 * `(cmd, positional)` and emit a notice. Resolving that in ONE pass before the
 * dispatcher `switch` means the switch only ever sees canonical commands — no alias
 * cases, no duplicated `start/stop/logs` bodies. Pure + exported so the deprecation
 * surface is unit-tested independently of the dispatcher I/O.
 */

export interface ResolvedAlias {
  /** The canonical command the dispatcher should run. */
  cmd: string;
  /** The canonical positional args (subcommand prepended / leading sub stripped). */
  positional: string[];
  /** The one-line stderr deprecation notice. */
  notice: string;
}

/** Simple 1:1 renames whose positional args pass straight through. The target may be
 *  a group path ("deps install") — the subcommand is prepended to the positionals. */
const SIMPLE_ALIASES: Record<string, string> = {
  link: "track",
  // hydrate/detect/doctor commented out along with `deps` itself (design 50) —
  // their forward target (the `deps` group) is currently disabled in index.ts.
  // hydrate: "deps install",
  // detect: "deps list",
  // doctor: "deps check",
};

const DAEMON_RENAME = "note: 'rbox daemon …' is now 'rbox start/stop/logs'.";

/** Resolve a deprecated alias to its canonical command + args + notice, or null if
 *  `cmd` is already canonical. */
export function resolveAlias(cmd: string, positional: string[]): ResolvedAlias | null {
  const target = SIMPLE_ALIASES[cmd];
  if (target) {
    const [to, sub] = target.split(" ");
    return {
      cmd: to!,
      positional: sub ? [sub, ...positional] : positional,
      notice: `note: 'rbox ${cmd}' is now 'rbox ${target}'.`,
    };
  }
  if (cmd === "daemon") {
    const sub = positional[0];
    const rest = positional.slice(1);
    if (sub === "start" || sub === "stop" || sub === "logs") return { cmd: sub, positional: rest, notice: DAEMON_RENAME };
    if (sub === "status") return { cmd: "status", positional: rest, notice: "note: daemon status is now part of 'rbox status'." };
    // Unknown daemon subcommand: still flag the rename, then fall through as `daemon`
    // (the dispatcher prints usage). No canonical target to rewrite to.
    return { cmd: "daemon", positional, notice: DAEMON_RENAME };
  }
  return null;
}
