import fsp from "node:fs/promises";
import path from "node:path";

export const DEV_API = "https://rbox-dev-api.brian-via.workers.dev";
export const UX_ROOT = "/tmp/rbox-ux";
export const SCRUBBED_ENV = [
  "RBOX_TOKEN", "RBOX_DEVICE_ID", "RBOX_ACCOUNT_ID", "RBOX_PAIR_TOKEN",
  "RBOX_CONFIG_DIR", "XDG_CONFIG_HOME", "RBOX_REMOTE", "RBOX_DEV_BOOTSTRAP",
  "RBOX_DEV_BOOTSTRAP_SECRET", "RBOX_KEY", "RBOX_APP",
] as const;

export type ExecutionMode = "container" | "host";

export function executionMode(host: boolean): ExecutionMode {
  return host ? "host" : "container";
}

export function safeId(kind: string, value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error(`${kind} must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}`);
  return value;
}

export function isolatedEnv(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of SCRUBBED_ENV) delete env[key];
  return { ...env, HOME: home, RBOX_HOME: home, RBOX_API: DEV_API, RBOX_API_QUIET: "1", RBOX_APP: "" };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function assertNoAncestorWorkspace(home: string): Promise<void> {
  let directory = await fsp.realpath(home);
  while (true) {
    const marker = path.join(directory, ".rbox", "workspace.json");
    try {
      await fsp.lstat(marker);
      throw new Error(`refusing rbox spawn: machine HOME is inside workspace at ${directory}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
