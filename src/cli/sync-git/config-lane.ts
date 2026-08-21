import fs from "node:fs/promises";
import path from "node:path";
import { hashBytes } from "../../engine/index.js";
import { repoCtxFromDisk, type RepoCtx } from "./git-state.js";
import { canonicalizeGitConfig, type GitConfig } from "./config-sync.js";
import { readStableParsedConfigSnapshot, type ConfigFault, type GitConfigRunner } from "./config-txn.js";
import { type ConfigStoreIdentity } from "../config.js";
import { repoDirOf } from "./shared.js";
/** `type`, not `interface`, so it keeps its implicit index signature and stays
 * comparable with `JsonValue` — it is embedded in the decoded divergence cache. */
export type CachedLocalCfg = {
  hash: string;
  nonEmpty: boolean;
};

export type LocalCfgRead =
  | { status: "ok"; config: GitConfig; cached: CachedLocalCfg }
  | { status: "over-bounds"; reason: string }
  | { status: "failed"; fault: ConfigFault };

/** Hash the canonical wire value, including the meaningful empty `{}` value. */
export function gitConfigHash(config: GitConfig): string {
  return hashBytes(Buffer.from(JSON.stringify(config)));
}

/** Design 93 §6 presence/edit predicate. Base presence is intentionally distinct
 * from an empty base config, and an unset sync point never equals a real hash. */
export function shouldPublishGitConfig(
  baseConfig: GitConfig | undefined,
  local: CachedLocalCfg,
  cfgSynced: string | undefined
): boolean {
  if (baseConfig === undefined) return local.nonEmpty && local.hash !== cfgSynced;
  const baseHash = gitConfigHash(baseConfig);
  return local.hash !== baseHash && local.hash !== cfgSynced;
}

export async function readLocalGitConfig(
  root: string,
  rel: string,
  diskCtx?: RepoCtx,
  runGit?: GitConfigRunner,
  onCredentialSkip?: () => void
): Promise<LocalCfgRead> {
  const repoDir = repoDirOf(root, rel);
  const ctx = diskCtx ?? (await repoCtxFromDisk(repoDir).catch(() => undefined));
  if (!ctx) {
    return {
      status: "failed",
      fault: { disposition: "transient", reason: "read-error", error: new Error("git repository context unavailable") },
    };
  }
  const configPath = path.join(ctx.commonDir, "config");
  let lastFault: ConfigFault | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = await readStableParsedConfigSnapshot(repoDir, configPath, "initial", runGit);
    if (!read.ok) {
      lastFault = read.fault;
      if (read.fault.disposition === "permanent") return { status: "failed", fault: read.fault };
      continue;
    }
    const canonical = canonicalizeGitConfig(read.snapshot.entries);
    if (canonical.rejected.some((item) => item.credential)) onCredentialSkip?.();
    if (!canonical.ok) {
      if (canonical.overBounds) return { status: "over-bounds", reason: canonical.reason };
      return {
        status: "failed",
        fault: { disposition: "permanent", reason: "parse-error", error: new Error(canonical.reason) },
      };
    }
    return {
      status: "ok",
      config: canonical.config,
      cached: { hash: gitConfigHash(canonical.config), nonEmpty: Object.keys(canonical.config).length > 0 },
    };
  }
  return {
    status: "failed",
    fault: lastFault ?? { disposition: "transient", reason: "read-error" },
  };
}

export function sameConfigStoreIdentity(a: ConfigStoreIdentity | undefined, b: ConfigStoreIdentity | undefined): boolean {
  return a !== undefined && b !== undefined && a.repoKind === b.repoKind &&
    a.commonDir.realpath === b.commonDir.realpath && a.commonDir.dev === b.commonDir.dev &&
    a.commonDir.ino === b.commonDir.ino && a.commonDir.birthtime === b.commonDir.birthtime;
}

/** Design 93 §9 receiver ownership: only a standalone dir repo whose common
 * store is contained by this workspace owns its local config lane. */
export async function configReceiver(root: string, ctx: RepoCtx): Promise<{ owned: boolean; storeIdentity: ConfigStoreIdentity; configPath: string }> {
  const [rootReal, gitReal, commonReal, stat] = await Promise.all([
    fs.realpath(root),
    fs.realpath(ctx.gitDir),
    fs.realpath(ctx.commonDir),
    fs.stat(ctx.commonDir, { bigint: true }),
  ]);
  const relative = path.relative(rootReal, commonReal);
  const contained = relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  const storeIdentity: ConfigStoreIdentity = {
    repoKind: ctx.kind,
    commonDir: {
      realpath: commonReal,
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      birthtime: stat.birthtimeNs > 0n ? stat.birthtimeNs.toString() : "0",
    },
  };
  return { owned: ctx.kind === "dir" && gitReal === commonReal && contained, storeIdentity, configPath: path.join(ctx.commonDir, "config") };
}
