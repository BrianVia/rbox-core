/**
 * Rig configuration + the load-bearing safety rail (design 56 §6/§12): the rig
 * must NEVER touch production. Everything the rig creates is namespaced `rig-*`
 * so teardown can never sweep an unrelated container/network/volume.
 *
 * PURE module — no I/O, no spawning. `up`/`run`/`down` import the constants and
 * the resolvers; the impure work lives in container.ts and rig.ts. That keeps the
 * two decisions we most need to trust — "is this prod?" and "did the image go
 * stale?" — unit-testable without a container runtime.
 */
import { createHash } from "node:crypto";

/** Namespaced resource names. `down --all` sweeps exactly the `rig-*` set. */
export const NAMES = {
  image: "rig-device",
  network: "rig-net",
  a: "rig-dev-a",
  b: "rig-dev-b",
} as const;

/** Guest-side paths. `src/`+`scripts/` are bind-mounted read-only so module
 *  resolution from the CLI entry walks up to the image's linux node_modules
 *  (native @parcel/watcher), never the host's macOS ones (design 56 §5). */
export const GUEST = {
  appDir: "/app",
  srcMount: "/app/src",
  scriptsMount: "/app/scripts",
  /** The container-local workspace — sync needs rw and must never touch host data. */
  workDir: "/work/ws",
  cliEntry: "/app/src/cli/index.ts",
  /** Image source-mode shim; a compiled candidate may be mounted over this path. */
  cliExecutable: "/opt/rbox/bin/rbox",
  corpusEntry: "/app/scripts/bench/corpus.ts",
  /** HOME is the image default (root); credentials land in /root/.rbox. */
  rboxHome: "/root/.rbox",
  /** Where the conductor workload volume is mounted (RO) into device A — the extracted
   *  `workspaces/` tree lives at `${workloadMount}/workspaces` (conductor-initial-sync). */
  workloadMount: "/workload",
} as const;

/** P0 = dev only. The deployed dev worker. */
export const DEFAULT_DEV_API = "https://rbox-dev-api.brian-via.workers.dev";

export interface RigConfig {
  apiUrl: string;
  repoRoot: string;
}

/**
 * Refuse prod. `api.rbox.to` (the prod API host) or any host containing
 * `rbox-prod-api` aborts before a single container is created. Parsed via `URL`
 * so a port suffix, an `http`/`https` scheme, a trailing path, or userinfo can't
 * smuggle the check — only the real connect host (`hostname`) is inspected.
 */
export function assertNotProd(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`invalid API URL ${JSON.stringify(url)}`);
  }
  if (host === "api.rbox.to" || host.includes("rbox-prod-api")) {
    throw new Error(
      `REFUSING to run against production (${host}). The rig is dev-only — ` +
        `unset RBOX_API / drop --api-url, or point at the dev worker.`
    );
  }
}

/**
 * Effective API URL: `--api-url` flag > `RBOX_API` env > dev default. Asserts the
 * effective URL is not prod AND — defense in depth (§12: "checked against env AND
 * flags") — that a prod value lurking in `RBOX_API` aborts even when a flag would
 * have dodged it, since the CLI inside the guest could otherwise read the stray env.
 */
export function resolveApiUrl(env: NodeJS.ProcessEnv, flags: Record<string, string>): string {
  const effective = flags["api-url"] ?? env.RBOX_API ?? DEFAULT_DEV_API;
  assertNotProd(effective);
  if (env.RBOX_API) assertNotProd(env.RBOX_API);
  return effective;
}

export function resolveConfig(env: NodeJS.ProcessEnv, flags: Record<string, string>, repoRoot: string): RigConfig {
  return { apiUrl: resolveApiUrl(env, flags), repoRoot };
}

/**
 * Image staleness key: a short digest of the three inputs that change what the
 * baked image contains (deps + lockfile + build recipe). `up` rebuilds when the
 * stored key differs. Order-stable and collision-separated by NUL so no input can
 * masquerade as another.
 */
export function imageHash(inputs: { packageJson: string; lockfile: string; dockerfile: string }): string {
  return createHash("sha256")
    .update(inputs.packageJson)
    .update("\0")
    .update(inputs.lockfile)
    .update("\0")
    .update(inputs.dockerfile)
    .digest("hex")
    .slice(0, 16);
}
