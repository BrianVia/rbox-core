/**
 * zsh completion generator (design 46 — "Completions").
 *
 * GENERATED, NOT MAINTAINED. The completion script is projected from
 * `COMMAND_HELP` (help-registry.ts) — the same single source of truth the
 * dispatcher and help screens already derive from — so completions cannot drift
 * from the real command surface by construction. There is no hand-kept list of
 * commands/flags here; edit the registry and the script follows.
 *
 * Consumed by `rbox completions zsh` (prints the script to stdout) and embedded
 * verbatim by `rbox shell-init zsh` (one eval wires plugin + completions, no
 * second spawn, no compinit file management). Wiring those commands lives in a
 * separate change — this module only produces the string.
 *
 * Contract for the integrator:
 *   - `zshCompletions()` returns a COMPLETE, self-contained zsh script: it
 *     defines `_rbox` and ends with a guarded `compdef` registration
 *     (`(( $+functions[compdef] )) && compdef _rbox rbox`) so it is safe to
 *     source whether or not `compinit` has already run.
 *   - Output is DETERMINISTIC (stable ordering, no timestamps) — safe to embed,
 *     diff, and snapshot.
 *   - Only PUBLIC commands appear (no `hidden`, no deprecated `alias`, no
 *     internal tokens like `__daemon-run`).
 */
import { COMMAND_HELP, type CommandHelp } from "./help-registry.js";

/** Escape a string for embedding inside a zsh single-quoted string literal. */
function sq(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/** Wrap content as a single-quoted zsh word (after single-quote escaping). */
function q(content: string): string {
  return `'${sq(content)}'`;
}

/**
 * Escape a description for the `[...]` slot of an `_arguments` optspec, where a
 * literal `]` (or `[`) would terminate/confuse the bracket. Colons are safe
 * inside the bracket, so they are left alone.
 */
function bracketDesc(s: string): string {
  return s.replace(/[[\]]/g, "\\$&");
}

/** The first token of a (possibly multi-word) command name, e.g. "deps". */
function firstWord(name: string): string {
  return name.split(" ")[0]!;
}

interface ParsedFlag {
  name: string; // e.g. "--only"
  takesArg: boolean;
  metavar: string; // e.g. "id" (without <>), "" for boolean flags
}

/** Parse a registry flag string ("--only <id>", "--allow-mass-delete", "--lines N"). */
function parseFlag(flag: string): ParsedFlag {
  const parts = flag.trim().split(/\s+/);
  const name = parts[0]!;
  const rest = parts.slice(1).join(" ").replace(/[<>]/g, "").trim();
  return { name, takesArg: parts.length > 1, metavar: rest };
}

/** `_arguments` optspecs for one command's flags, in registry order. */
function flagSpecs(c: CommandHelp): string[] {
  if (!c.flags?.length) return [];
  return c.flags.map((f) => {
    const { name, takesArg, metavar } = parseFlag(f.flag);
    const desc = bracketDesc(f.desc);
    if (!takesArg) return q(`${name}[${desc}]`);
    // A path-shaped argument gets file completion; everything else just names
    // the metavar (accepts an arg, offers no specific completion).
    const action = /path/i.test(metavar) ? ":_files" : "";
    return q(`${name}[${desc}]:${metavar || "arg"}${action}`);
  });
}

/** True when a command's usage takes a filesystem path positional. */
function takesPath(c: CommandHelp): boolean {
  return /(?:^|[\s<[])path\b/.test(c.usage);
}

/** A `_describe` array entry: `value:description` (first colon splits). */
function describeEntry(value: string, desc: string): string {
  return q(`${value}:${desc}`);
}

function indent(lines: string[], pad: string): string[] {
  return lines.map((l) => (l.length ? pad + l : l));
}

/** The `case` arm body for a single leaf command (flags + optional path files). */
function leafArm(c: CommandHelp): string[] {
  const specs = flagSpecs(c);
  if (takesPath(c)) specs.push(q("*:path:_files"));
  if (!specs.length) return [];
  return [`_arguments \\`, ...indent(specs.map((s, i) => (i === specs.length - 1 ? s : `${s} \\`)), "  ")];
}

/** The nested `case` arm body for a multi-word group (e.g. "deps"). */
function groupArm(word: string, entries: CommandHelp[]): string[] {
  const subs = entries
    .filter((e) => e.name !== word) // multi-word children only
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const arrayVar = `_rbox_${word}_cmds`;
  const lines: string[] = [];
  lines.push(`local -a ${arrayVar}`);
  lines.push(`${arrayVar}=(`);
  for (const s of subs) {
    const leaf = s.name.slice(word.length + 1); // "install" from "deps install"
    lines.push(...indent([describeEntry(leaf, s.summary)], "  "));
  }
  lines.push(`)`);
  lines.push(`_arguments -C \\`);
  lines.push(`  '1: :->${word}_cmd' \\`);
  lines.push(`  '*::arg:->${word}_arg'`);
  lines.push(`case "$state" in`);
  lines.push(`  ${word}_cmd)`);
  lines.push(`    _describe -t commands 'rbox ${word} command' ${arrayVar}`);
  lines.push(`    ;;`);
  lines.push(`  ${word}_arg)`);
  lines.push(`    case "$line[1]" in`);
  for (const s of subs) {
    const leaf = s.name.slice(word.length + 1);
    const arm = leafArm(s);
    if (!arm.length) continue;
    lines.push(`      ${leaf})`);
    lines.push(...indent(arm, "        "));
    lines.push(`        ;;`);
  }
  lines.push(`    esac`);
  lines.push(`    ;;`);
  lines.push(`esac`);
  return lines;
}

/**
 * Build a complete zsh completion script for the `rbox` CLI from `COMMAND_HELP`.
 * See the module doc-comment for the integrator contract.
 */
export function zshCompletions(): string {
  const publicCmds = COMMAND_HELP.filter((c) => !c.hidden && !c.alias);

  // Group public commands by their first word so multi-word names ("deps
  // install") collapse into a subcommand group under their head ("deps").
  const byHead = new Map<string, CommandHelp[]>();
  for (const c of publicCmds) {
    const head = firstWord(c.name);
    const bucket = byHead.get(head) ?? [];
    bucket.push(c);
    byHead.set(head, bucket);
  }
  const heads = [...byHead.keys()].sort();

  const lines: string[] = [];
  lines.push("#compdef rbox");
  lines.push("# rbox zsh completions — generated from COMMAND_HELP (design 46).");
  lines.push("# Do not edit by hand; regenerate with `rbox completions zsh`.");
  lines.push("");
  lines.push("_rbox() {");
  lines.push("  local curcontext=\"$curcontext\" state line");
  lines.push("  typeset -A opt_args");
  lines.push("");
  lines.push("  local -a _rbox_cmds");
  lines.push("  _rbox_cmds=(");
  for (const head of heads) {
    const entries = byHead.get(head)!;
    const leaf = entries.find((e) => e.name === head);
    // A group with no leaf entry (e.g. "deps") is described by its group label.
    const desc = leaf ? leaf.summary : entries[0]!.group.toLowerCase();
    lines.push(...indent([describeEntry(head, desc)], "    "));
  }
  lines.push("  )");
  lines.push("");
  lines.push("  _arguments -C \\");
  lines.push("    '1: :->cmd' \\");
  lines.push("    '*::arg:->arg'");
  lines.push("");
  lines.push("  case \"$state\" in");
  lines.push("    cmd)");
  lines.push("      _describe -t commands 'rbox command' _rbox_cmds");
  lines.push("      ;;");
  lines.push("    arg)");
  lines.push("      case \"$line[1]\" in");
  for (const head of heads) {
    const entries = byHead.get(head)!;
    const leaf = entries.find((e) => e.name === head);
    const isGroup = entries.some((e) => e.name !== head);
    let arm: string[];
    if (isGroup) {
      arm = groupArm(head, entries);
    } else if (leaf) {
      arm = leafArm(leaf);
    } else {
      arm = [];
    }
    if (!arm.length) continue;
    lines.push(`        ${head})`);
    lines.push(...indent(arm, "          "));
    lines.push(`          ;;`);
  }
  lines.push("      esac");
  lines.push("      ;;");
  lines.push("  esac");
  lines.push("}");
  lines.push("");
  // Guarded registration: safe whether or not compinit/compdef exists yet.
  lines.push("(( $+functions[compdef] )) && compdef _rbox rbox");
  lines.push("");
  return lines.join("\n");
}
