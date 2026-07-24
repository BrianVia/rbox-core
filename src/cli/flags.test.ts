import { expect, test } from "bun:test";
import { ALIAS_COMMANDS } from "./command-catalog.js";
import { parseFlags, unknownFlagError } from "./flags.js";
import { COMMAND_HELP, helpFor } from "./help-registry.js";

test("--json is a boolean long flag before or after a status path", () => {
  expect(parseFlags(["--json", "."])).toEqual({ positional: ["."], flags: { json: "true" } });
  expect(parseFlags([".", "--json"])).toEqual({ positional: ["."], flags: { json: "true" } });
});

test("--json is a boolean long flag before or after a device subcommand", () => {
  expect(parseFlags(["--json", "list"])).toEqual({ positional: ["list"], flags: { json: "true" } });
  expect(parseFlags(["list", "--json"])).toEqual({ positional: ["list"], flags: { json: "true" } });
});

test("boolean long flags do not consume following positionals", () => {
  expect(parseFlags(["--follow", "."])).toEqual({ positional: ["."], flags: { follow: "true" } });
  expect(parseFlags(["--yes", "genesis"])).toEqual({ positional: ["genesis"], flags: { yes: "true" } });
  expect(parseFlags(["--annual", "solo"])).toEqual({ positional: ["solo"], flags: { annual: "true" } });
  expect(parseFlags(["deferrals", "--brief"])).toEqual({ positional: ["deferrals"], flags: { brief: "true" } });
});

test("known value long flags still consume values", () => {
  expect(parseFlags(["--limit", "25", "--path", "."])).toEqual({ positional: [], flags: { limit: "25", path: "." } });
});

test("ignore respect-gitignore consumes on/off value", () => {
  expect(parseFlags(["--respect-gitignore", "on", "--path", "."], "ignore")).toEqual({
    positional: [],
    flags: { "respect-gitignore": "on", path: "." },
  });
});

// ── per-command arity ────────────────────────────────────────────────────────
// One registry-wide arity map keyed by flag NAME let the last registration win, so
// `rbox status --git <path>` (valueless `--git`) parsed as `git: "<path>"` and lost
// BOTH the git detail and the path. Arity is per command; the map must be too.

test("status --git is valueless and never swallows the status path", () => {
  expect(parseFlags(["--git", "/home/dev/app"], "status")).toEqual({ positional: ["/home/dev/app"], flags: { git: "true" } });
  expect(parseFlags(["/home/dev/app", "--git"], "status")).toEqual({ positional: ["/home/dev/app"], flags: { git: "true" } });
});

test("init/track --git <true|false> still consumes its value", () => {
  expect(parseFlags(["--git", "false"], "init")).toEqual({ positional: [], flags: { git: "false" } });
  expect(parseFlags(["--git", "false"], "track")).toEqual({ positional: [], flags: { git: "false" } });
  expect(parseFlags(["--git=false"], "init")).toEqual({ positional: [], flags: { git: "false" } });
});

test("init/track --respect-gitignore is valueless and never swallows the directory", () => {
  expect(parseFlags(["--respect-gitignore", "/home/dev/app"], "track")).toEqual({
    positional: ["/home/dev/app"],
    flags: { "respect-gitignore": "true" },
  });
  expect(parseFlags(["--respect-gitignore", "--root", "/home/dev/app"], "init")).toEqual({
    positional: [],
    flags: { "respect-gitignore": "true", root: "/home/dev/app" },
  });
});

test("flags a command accepts but does not document keep their registry-wide arity", () => {
  // `--no-interactive` is a HIDDEN_FLAGS entry for `track` (declared only under `init`).
  expect(parseFlags(["--no-interactive", "/home/dev/app"], "track")).toEqual({
    positional: ["/home/dev/app"],
    flags: { "no-interactive": "true" },
  });
});

test("a deprecated alias parses its target's flags at the target's arity", () => {
  // `link` forwards the SAME argv to `track` (deprecations.ts) but declares no flags of
  // its own, so resolving arity from the alias entry alone left `--git` on the colliding
  // fallback (valueless): `rbox link --git false <path>` lost the path AND inverted --git.
  expect(parseFlags(["--git", "false", "/desired/project"], "link")).toEqual({
    positional: ["/desired/project"],
    flags: { git: "false" },
  });
});

test("an unresolvable command falls back to the union, valueless for names that collide", () => {
  expect(parseFlags(["--limit", "25"], "frobnicate")).toEqual({ positional: [], flags: { limit: "25" } });
  expect(parseFlags(["--git", "/home/dev/app"], "frobnicate")).toEqual({ positional: ["/home/dev/app"], flags: { git: "true" } });
  expect(parseFlags(["--git", "/home/dev/app"])).toEqual({ positional: ["/home/dev/app"], flags: { git: "true" } });
});

// ── registry guards (keep the parser's arity source unambiguous) ──────────────

const FLAG_TOKEN = /^(--[a-z0-9][a-z0-9-]*)\b/i;

function declaredFlags(command: { name: string; flags?: { flag: string }[] }): { name: string; takesValue: boolean }[] {
  const declared: { name: string; takesValue: boolean }[] = [];
  for (const { flag } of command.flags ?? []) {
    const token = flag.match(FLAG_TOKEN)?.[1];
    if (token) declared.push({ name: token.slice(2), takesValue: flag.slice(token.length).trim().length > 0 });
  }
  return declared;
}

const arityWord = (takesValue: boolean) => (takesValue ? "WITH a value" : "WITHOUT a value");

/** Deprecated alias → the command path it forwards the same argv to (`link` → `track`). */
const ALIAS_TARGETS = new Map(ALIAS_COMMANDS.map((name) => [name, COMMAND_HELP.find((c) => c.name === name)!.alias!]));

test("registry guard: one resolved help key never declares a flag name at two arities", () => {
  // `parseFlags` resolves a command to `helpFor(cmd)`, which for a group token unions
  // every sub-verb. Within one such key the last declaration would silently win — the
  // exact defect this map was rebuilt to kill — so the registry must not contain one.
  const keys = new Set(COMMAND_HELP.flatMap((c) => [c.name, c.name.split(" ")[0]!]));
  const conflicts: string[] = [];
  for (const key of [...keys].sort()) {
    const seen = new Map<string, { takesValue: boolean; command: string }>();
    for (const entry of helpFor(key) ?? []) {
      for (const { name, takesValue } of declaredFlags(entry)) {
        const prev = seen.get(name);
        if (prev && prev.takesValue !== takesValue) {
          conflicts.push(
            `--${name} under \`rbox ${key}\`: ${prev.command} declares it ${arityWord(prev.takesValue)}, ${entry.name} declares it ${arityWord(takesValue)} — split the key or align the two declarations`,
          );
        }
        seen.set(name, { takesValue, command: entry.name });
      }
    }
  }
  expect(conflicts).toEqual([]);
});

test("registry guard: flag names that collide ACROSS commands are resolved per command", () => {
  // Cross-command collisions are legitimate (`--git` is a status presentation toggle
  // and an init/track setting), so this pins the inventory instead of banning it: a new
  // colliding name must be reviewed here, and every entry must parse per its command.
  const byFlag = new Map<string, { command: string; takesValue: boolean }[]>();
  for (const command of COMMAND_HELP) {
    for (const { name, takesValue } of declaredFlags(command)) {
      byFlag.set(name, [...(byFlag.get(name) ?? []), { command: command.name, takesValue }]);
    }
  }
  const colliding = [...byFlag].filter(([, decls]) => new Set(decls.map((d) => d.takesValue)).size > 1);
  // Alias arity is resolved in ONE hop, so no alias may forward to another alias.
  for (const target of ALIAS_TARGETS.values()) expect(ALIAS_TARGETS.has(target.split(" ")[0]!)).toBe(false);

  expect(colliding.map(([name, decls]) => `--${name}: ${decls.map((d) => `${d.command} ${arityWord(d.takesValue)}`).join("; ")}`).sort()).toEqual([
    "--git: status WITHOUT a value; init WITH a value; track WITH a value",
    "--respect-gitignore: init WITHOUT a value; track WITHOUT a value; ignore WITH a value",
  ]);

  for (const [name, decls] of colliding) {
    for (const { command, takesValue } of decls) {
      const parsed = parseFlags([`--${name}`, "NEXT"], command.split(" ")[0]!);
      expect({ command, ...parsed }).toEqual(
        takesValue
          ? { command, positional: [], flags: { [name]: "NEXT" } }
          : { command, positional: ["NEXT"], flags: { [name]: "true" } },
      );
    }
    // A deprecated alias declares no flags of its own but forwards the SAME argv to its
    // target, so it must parse a colliding name at the TARGET's arity — never at the
    // unattributable fallback arity below (the `rbox link --git false <path>` defect).
    for (const [alias, target] of ALIAS_TARGETS) {
      const declared = decls.find((d) => d.command === target.split(" ")[0]);
      if (!declared) continue;
      expect({ alias, name, ...parseFlags([`--${name}`, "NEXT"], alias) }).toEqual({
        alias,
        name,
        ...parseFlags([`--${name}`, "NEXT"], declared.command),
      });
    }
    // Unattributable (no resolvable command): never swallow the following argument.
    expect({ name, ...parseFlags([`--${name}`, "NEXT"]) }).toEqual({ name, positional: ["NEXT"], flags: { [name]: "true" } });
  }
});

test("unknown flags are rejected against command and subcommand help", () => {
  expect(unknownFlagError("start", [], { pullonly: "true" })).toContain("--pullonly");
  expect(unknownFlagError("start", [], { pullonly: "true" })).toContain("rbox start --help");
  expect(unknownFlagError("start", [], { "pull-only": "true" })).toBeUndefined();
  expect(unknownFlagError("start", [], { "read-write": "true" })).toBeUndefined();
  expect(unknownFlagError("key", ["materialize"], { "key-file": "x" })).toBeUndefined();
  expect(unknownFlagError("git", ["deferrals"], { brief: "true" })).toBeUndefined();
  expect(unknownFlagError("git", ["deferrals"], { confirm: "x" })).toContain("--confirm");
});

test("global and real undocumented flags remain allowed", () => {
  expect(unknownFlagError("track", [], { "no-interactive": "true" })).toBeUndefined();
  expect(unknownFlagError("status", [], { json: "true" })).toBeUndefined();
});
