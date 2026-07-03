/**
 * Account lifecycle glue: resolve the dev bootstrap secret (never printing it) and
 * run the host-side per-run teardown (`DELETE /v1/account`), which doubles as a
 * live exercise of the design-37 deletion cascade.
 *
 * The secret resolution + file parse + redaction are PURE (unit-tested with fs
 * fixtures); the network teardown is a thin `fetch`.
 */
import fs from "node:fs";
import path from "node:path";

const SECRET_FILE = "dev-keys.local.secret";
const SECRET_KEY = "RBOX_DEV_BOOTSTRAP_SECRET";
const ENV_KEY = "RBOX_DEV_BOOTSTRAP";

/** Extract `KEY=<value>` from a `.local.secret` (KEY=VALUE, one per line). Quotes
 *  and surrounding whitespace are stripped; a missing key returns undefined. PURE. */
export function parseSecretFile(content: string, key: string): string | undefined {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v || undefined;
  }
  return undefined;
}

/**
 * The candidate repo roots to probe for `dev-keys.local.secret`. The file is
 * gitignored, so a WORKTREE checkout never has its own copy — when `repoRoot` is a
 * `.claude/worktrees/<slug>` path we also probe the primary checkout (the segment
 * before `/.claude/worktrees/`). PURE.
 */
export function candidateRoots(repoRoot: string): string[] {
  const roots = [repoRoot];
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const idx = repoRoot.indexOf(marker);
  if (idx >= 0) {
    const primary = repoRoot.slice(0, idx);
    if (primary && primary !== repoRoot) roots.push(primary);
  }
  return roots;
}

/** Redact known secret substrings from a string (argv rendering, logs). PURE. */
export function redactSecret(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("***") : text;
}

export interface SecretDeps {
  env: NodeJS.ProcessEnv;
  readFile: (p: string) => string | undefined;
}

/**
 * Resolve the dev bootstrap secret: env `RBOX_DEV_BOOTSTRAP` wins, else the
 * `RBOX_DEV_BOOTSTRAP_SECRET=` line in `dev-keys.local.secret` (worktree → primary
 * checkout), else a hard error naming both options. NEVER logs the value.
 */
export function resolveBootstrapSecret(repoRoot: string, deps: SecretDeps = defaultSecretDeps()): string {
  const fromEnv = deps.env[ENV_KEY]?.trim();
  if (fromEnv) return fromEnv;
  for (const root of candidateRoots(repoRoot)) {
    const content = deps.readFile(path.join(root, SECRET_FILE));
    if (content) {
      const v = parseSecretFile(content, SECRET_KEY);
      if (v) return v;
    }
  }
  throw new Error(
    `rig: no dev bootstrap secret. Set ${ENV_KEY}=<secret>, or add a line ` +
      `${SECRET_KEY}=<secret> to ${SECRET_FILE} at the repo root.`
  );
}

function defaultSecretDeps(): SecretDeps {
  return {
    env: process.env,
    readFile: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

export interface DeleteResult {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * Owner-only `DELETE /v1/account` (design 37). The confirmation contract accepts
 * the account id (the CLI-account fallback for accounts with no email on file), so
 * we confirm with `accountId`. A 2xx tombstones + schedules the purge cascade.
 */
export async function deleteAccount(apiUrl: string, token: string, accountId: string): Promise<DeleteResult> {
  const res = await fetch(`${apiUrl}/v1/account`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ confirm: accountId }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

/** Parse `~/.rbox/credentials.json` contents for the fields teardown needs. */
export function readCredentials(json: string): { token: string; accountId?: string; deviceId?: string } {
  const c = JSON.parse(json) as { token?: string; accountId?: string; deviceId?: string };
  if (!c.token) throw new Error("rig: credentials.json has no token");
  return { token: c.token, accountId: c.accountId, deviceId: c.deviceId };
}
