/**
 * The rbox command surface, DERIVED from the help registry (design 29).
 *
 * `COMMAND_HELP` is the single source of truth for what commands exist; this module
 * projects it into the views the dispatcher needs — so the catalog can't drift from
 * help by construction (no second hand-maintained list). The one parity that still
 * matters — registry ↔ the dispatcher `switch` — is what `KNOWN_TOP_LEVEL` guards:
 * it powers the unknown-command exit code, so a help entry with no switch case (or
 * vice versa) surfaces as a wrong/at-the-grouped-screen result.
 */
import { COMMAND_HELP } from "./help-registry.js";

const firstWord = (s: string): string => s.split(" ")[0]!;

/** Public, user-facing commands (shown in the grouped help screen). */
export const PUBLIC_COMMANDS: string[] = COMMAND_HELP.filter((c) => !c.hidden).map((c) => c.name);

/** Deprecated aliases — dispatched, warn on stderr, removed at v0.3. */
export const ALIAS_COMMANDS: string[] = COMMAND_HELP.filter((c) => c.alias).map((c) => c.name);

/** Hidden real commands plus internal dispatcher tokens. */
export const HIDDEN_COMMANDS: string[] = [
  ...COMMAND_HELP.filter((c) => c.hidden && !c.alias).map((c) => c.name),
  "help",
  "__daemon-run",
  "__boot-resume",
];

/** Every top-level token the dispatcher's `switch` must handle (incl. aliases). */
export const KNOWN_TOP_LEVEL: ReadonlySet<string> = new Set<string>([
  ...COMMAND_HELP.map((c) => firstWord(c.name)),
  "help",
  "__daemon-run",
  "__boot-resume",
  // `--version` / `-v` are handled before the switch, not real subcommands.
]);

export function isKnownTopLevel(cmd: string | undefined): boolean {
  return cmd !== undefined && KNOWN_TOP_LEVEL.has(cmd);
}
