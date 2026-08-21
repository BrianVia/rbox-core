import { COMMAND_HELP, GLOBAL_FLAGS, helpFor, helpKeyFor, resolveCommandAlias, type CommandFlag } from "./help-registry.js";

const REPEATABLE_VALUE_SEPARATOR = "\0";

/** Return every value of an allowlisted repeatable flag without widening the
 * command layer's long-standing `Record<string, string>` flag contract. NUL cannot
 * occur in an OS argv entry, so it is an unambiguous internal separator. */
export function flagValues(flags: Record<string, string>, key: string): string[] {
  const value = flags[key];
  return value === undefined ? [] : value.split(REPEATABLE_VALUE_SEPARATOR);
}

function setLongFlag(flags: Record<string, string>, key: string, value: string, repeatable: boolean): void {
  const previous = flags[key];
  flags[key] = repeatable && previous !== undefined
    ? `${previous}${REPEATABLE_VALUE_SEPARATOR}${value}`
    : value;
}

interface FlagSyntax {
  takesValue: boolean;
  repeatable: boolean;
}

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string>;
}

function flagName(flag: CommandFlag): string | undefined {
  const token = flag.flag.split(/\s+/, 1)[0];
  return token?.startsWith("--") ? token.slice(2) : undefined;
}

function flagSyntax(flag: CommandFlag): FlagSyntax {
  return { takesValue: flag.takesValue === true, repeatable: flag.repeatable === true };
}

const SHORT_FLAGS: ReadonlyMap<string, { key: string } & FlagSyntax> = new Map(
  COMMAND_HELP.flatMap((command) => (command.flags ?? []).flatMap((flag) => {
    const key = flagName(flag);
    return flag.short && key ? [[flag.short, { key, ...flagSyntax(flag) }] as const] : [];
  })),
);

/**
 * Fallback arity for a command we cannot resolve (`rbox help`, an internal `__…`
 * verb, a typo): the union over the whole registry, with any name whose arity
 * DIFFERS between commands pinned to valueless. Arity is a per-command property, so
 * a union cannot answer for a name two commands spell differently; valueless is the
 * safe answer, because reading no value can never swallow the user's next argument.
 * A flag that really wanted a value then fails loudly downstream instead of silently
 * eating a path. `flags.test.ts` pins the colliding-name inventory.
 */
const FALLBACK_LONG_FLAG_SYNTAX = ((): Map<string, FlagSyntax> => {
  const syntax = new Map<string, FlagSyntax>();
  const collides = new Set<string>();
  for (const flags of [GLOBAL_FLAGS, ...COMMAND_HELP.map((command) => command.flags ?? [])]) {
    for (const flag of flags) {
      const name = flagName(flag);
      if (!name) continue;
      const declared = flagSyntax(flag);
      const previous = syntax.get(name);
      if (previous !== undefined && previous.takesValue !== declared.takesValue) collides.add(name);
      syntax.set(name, declared);
    }
  }
  for (const name of collides) syntax.set(name, { takesValue: false, repeatable: false });
  return syntax;
})();

/**
 * Arity for one command: the fallback union overlaid with that command's OWN
 * declarations. The overlay is what makes `rbox status --git <path>` (valueless) and
 * `rbox init --git false` (valued) both parse correctly; hidden accepted syntax is
 * declared beside visible syntax in the same command entry.
 * `helpFor` unions a group's sub-verbs, which is unambiguous only because no single
 * help key declares one name at two arities — enforced by a guard in `flags.test.ts`.
 * A deprecated alias is resolved to its target first: the dispatcher rewrites `link` to
 * `track` only AFTER parsing, so without that hop `rbox link --git false <path>` parsed
 * against the alias's empty declarations and lost the path.
 */
function longFlagSyntaxFor(cmd: string | undefined): Map<string, FlagSyntax> {
  const entries = cmd ? helpFor(resolveCommandAlias(cmd)) : undefined;
  if (!entries) return FALLBACK_LONG_FLAG_SYNTAX;
  const syntax = new Map(FALLBACK_LONG_FLAG_SYNTAX);
  for (const entry of entries) {
    for (const flag of entry.flags ?? []) {
      const name = flagName(flag);
      if (name) syntax.set(name, flagSyntax(flag));
    }
  }
  return syntax;
}

export function parseFlags(args: string[], cmd?: string): ParsedFlags {
  const longFlagSyntax = longFlagSyntaxFor(cmd);
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const value = eq === -1 ? undefined : a.slice(eq + 1);
      const syntax = longFlagSyntax.get(key);
      if (value !== undefined) {
        setLongFlag(flags, key, value, syntax?.repeatable === true);
      } else if (syntax?.takesValue === false) {
        flags[key] = "true";
      } else {
        const next = args[i + 1] && !args[i + 1]!.startsWith("--") ? args[++i]! : undefined;
        setLongFlag(flags, key, next ?? (syntax?.repeatable ? "" : "true"), syntax?.repeatable === true);
      }
    } else if (SHORT_FLAGS.has(a)) {
      const spec = SHORT_FLAGS.get(a)!;
      flags[spec.key] = spec.takesValue && args[i + 1] && !args[i + 1]!.startsWith("-") ? args[++i]! : "true";
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export function unknownFlagError(cmd: string, positional: string[], flags: Record<string, string>): string | undefined {
  const entries = helpFor(helpKeyFor(cmd, positional));
  if (!entries) return undefined;
  const allowed = new Set(GLOBAL_FLAGS.flatMap((flag) => flagName(flag) ?? []));
  for (const entry of entries) {
    for (const flag of entry.flags ?? []) {
      const name = flagName(flag);
      if (name) allowed.add(name);
    }
  }
  const key = Object.keys(flags).find((candidate) => !allowed.has(candidate));
  return key ? `unknown flag --${key} for \`rbox ${cmd}\` — run \`rbox ${cmd} --help\` to see its flags` : undefined;
}

/**
 * Surplus-positional gate (#515). `rbox export ~/code/myapp` used to exit 0
 * having exported the CWD workspace: the argument parsed, and no handler read
 * it. Capacity is DECLARED per registry entry, not read out of the usage prose.
 */
export function extraPositionalError(cmd: string, positional: string[]): string | undefined {
  const key = helpKeyFor(cmd, positional);
  const entries = helpFor(key);
  if (!entries) return undefined;
  let allowed = 0;
  for (const entry of entries) {
    if (entry.positionals === "variadic") return undefined;
    allowed = Math.max(allowed, entry.positionals);
  }
  if (positional.length <= allowed) return undefined;
  return `unexpected argument "${positional[allowed]}" for \`rbox ${key}\` — usage: ${entries[0]!.usage}`;
}
