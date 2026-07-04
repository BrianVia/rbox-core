import { COMMAND_HELP } from "./help-registry.js";

const SHORT_FLAGS: Record<string, { key: string; takesValue?: true }> = {
  "-f": { key: "follow" },
  "-n": { key: "lines", takesValue: true },
  "-y": { key: "yes" },
  "-w": { key: "workspace", takesValue: true },
};

const longFlagArity = new Map<string, boolean>();
for (const command of COMMAND_HELP) {
  for (const { flag } of command.flags ?? []) {
    const m = flag.match(/^(--[a-z0-9][a-z0-9-]*)\b/i);
    if (!m) continue;
    const token = m[1];
    if (!token) continue;
    longFlagArity.set(token.slice(2), flag.slice(token.length).trim().length > 0);
  }
}

export function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
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
