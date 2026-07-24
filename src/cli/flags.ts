import { COMMAND_HELP, helpFor, helpKeyFor, resolveCommandAlias } from "./help-registry.js";

const SHORT_FLAGS: Record<string, { key: string; takesValue?: true }> = {
  "-f": { key: "follow" },
  "-n": { key: "lines", takesValue: true },
  "-y": { key: "yes" },
  "-w": { key: "workspace", takesValue: true },
};

/** A help entry's `--flag`/`--flag <value>` spec → its name and whether it takes a value. */
function declaredArity(flag: string): { name: string; takesValue: boolean } | undefined {
  const token = flag.match(/^(--[a-z0-9][a-z0-9-]*)\b/i)?.[1];
  if (!token) return undefined;
  return { name: token.slice(2), takesValue: flag.slice(token.length).trim().length > 0 };
}

/**
 * Fallback arity for a command we cannot resolve (`rbox help`, an internal `__…`
 * verb, a typo): the union over the whole registry, with any name whose arity
 * DIFFERS between commands pinned to valueless. Arity is a per-command property, so
 * a union cannot answer for a name two commands spell differently; valueless is the
 * safe answer, because reading no value can never swallow the user's next argument.
 * A flag that really wanted a value then fails loudly downstream instead of silently
 * eating a path. `flags.test.ts` pins the colliding-name inventory.
 */
const FALLBACK_LONG_FLAG_ARITY = ((): Map<string, boolean> => {
  const arity = new Map<string, boolean>();
  const collides = new Set<string>();
  for (const command of COMMAND_HELP) {
    for (const { flag } of command.flags ?? []) {
      const declared = declaredArity(flag);
      if (!declared) continue;
      const prev = arity.get(declared.name);
      if (prev !== undefined && prev !== declared.takesValue) collides.add(declared.name);
      arity.set(declared.name, declared.takesValue);
    }
  }
  for (const name of collides) arity.set(name, false);
  return arity;
})();

/**
 * Arity for one command: the fallback union overlaid with that command's OWN
 * declarations. The overlay is what makes `rbox status --git <path>` (valueless) and
 * `rbox init --git false` (valued) both parse correctly; the base keeps flags a
 * command accepts but does not document (HIDDEN_FLAGS below — e.g. `rbox track
 * --no-interactive`) parsing exactly as the registry-wide union always did.
 * `helpFor` unions a group's sub-verbs, which is unambiguous only because no single
 * help key declares one name at two arities — enforced by a guard in `flags.test.ts`.
 * A deprecated alias is resolved to its target first: the dispatcher rewrites `link` to
 * `track` only AFTER parsing, so without that hop `rbox link --git false <path>` parsed
 * against the alias's empty declarations and lost the path.
 */
function longFlagArityFor(cmd: string | undefined): Map<string, boolean> {
  const entries = cmd ? helpFor(resolveCommandAlias(cmd)) : undefined;
  if (!entries) return FALLBACK_LONG_FLAG_ARITY;
  const arity = new Map(FALLBACK_LONG_FLAG_ARITY);
  for (const entry of entries) {
    for (const { flag } of entry.flags ?? []) {
      const declared = declaredArity(flag);
      if (declared) arity.set(declared.name, declared.takesValue);
    }
  }
  return arity;
}

export function parseFlags(args: string[], cmd?: string): { positional: string[]; flags: Record<string, string> } {
  const longFlagArity = longFlagArityFor(cmd);
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const value = eq === -1 ? undefined : a.slice(eq + 1);
      const takesValue = longFlagArity.get(key);
      if (value !== undefined) {
        flags[key] = value;
      } else if (takesValue === false) {
        flags[key] = "true";
      } else {
        flags[key] = args[i + 1] && !args[i + 1]!.startsWith("--") ? args[++i]! : "true";
      }
    } else if (SHORT_FLAGS[a]) {
      const spec = SHORT_FLAGS[a]!;
      flags[spec.key] = spec.takesValue && args[i + 1] && !args[i + 1]!.startsWith("-") ? args[++i]! : "true";
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const HIDDEN_FLAGS: Record<string, string[]> = {
  track: ["project", "name", "device", "no-interactive"],
  init: ["name", "project", "pull-only"],
  setup: ["new", "name", "no-sync", "respect-gitignore"],
};

export function unknownFlagError(cmd: string, positional: string[], flags: Record<string, string>): string | undefined {
  const entries = helpFor(helpKeyFor(cmd, positional));
  if (!entries) return undefined;
  const allowed = new Set(["json", "help", ...(HIDDEN_FLAGS[cmd] ?? [])]);
  for (const entry of entries) {
    for (const { flag } of entry.flags ?? []) {
      const token = flag.match(/^(--[a-z0-9][a-z0-9-]*)\b/i)?.[1];
      if (token) allowed.add(token.slice(2));
    }
  }
  const key = Object.keys(flags).find((candidate) => !allowed.has(candidate));
  return key ? `unknown flag --${key} for \`rbox ${cmd}\` — run \`rbox ${cmd} --help\` to see its flags` : undefined;
}
