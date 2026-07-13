import fs from "node:fs/promises";
import path from "node:path";
import { buildIgnoreMatcher, effectiveIgnoreRules, HashCache, scanManifest } from "../engine/index.js";
import { loadConfig, loadState, saveConfig, syncStreamId } from "./config.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { promptConfirm } from "./prompt.js";
import { pushManifest } from "./sync.js";

const RBOXIGNORE = ".rboxignore";

/** Append a pattern to `.rboxignore` (synced, shared across machines), de-duped. */
export async function addIgnorePattern(root: string, pattern: string): Promise<void> {
  const file = path.join(root, RBOXIGNORE);
  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch {
    /* new file */
  }
  const lines = existing.split("\n").map((l) => l.trim());
  if (lines.includes(pattern.trim())) {
    console.log(`already ignored: ${pattern}`);
    return;
  }
  const next = existing && !existing.endsWith("\n") ? `${existing}\n${pattern}\n` : `${existing}${pattern}\n`;
  await fs.writeFile(file, next);
  console.log(`added to ${RBOXIGNORE}: ${pattern}`);
  if (isSlashlessNegation(pattern)) {
    console.warn(`warning: slashless .rboxignore negation disables gitignore directory pruning; scans stay correct but may be slower.`);
  }
  console.log(`(forward-only: already-synced matches keep their last copy on other machines and stop syncing.`);
  console.log(` to remove a file from all machines, delete it FIRST, let that sync, then ignore it.)`);
}

/** Print the effective ignore rule set, labeled by source, in precedence order. */
export function listIgnoreRules(root: string): void {
  const rules = effectiveIgnoreRules(root);
  console.log(`effective ignore rules (precedence: builtin → .gitignore → .rboxignore):`);
  for (const r of rules) console.log(`  [${r.source}] ${r.pattern}`);
}

export async function setRespectGitignore(root: string, raw: string | undefined): Promise<void> {
  const value = parseOnOff(raw);
  if (value === undefined) throw new Error("usage: rbox ignore --respect-gitignore <on|off>");
  const cfg = await loadConfig(root);
  await saveConfig(root, { ...cfg, respectGitignore: value });
  console.log(`respectGitignore: ${value ? "on" : "off"}`);
  if (value) {
    console.log(`already-synced ignored files are carried forward. Run \`rbox ignore --purge\` to delete those stale copies explicitly.`);
  }
}

export async function purgeIgnored(root: string, opts: { yes?: boolean; allowMassDelete?: boolean } = {}): Promise<void> {
  const { cfg, deps } = await buildAuthedRemote(root);
  const state = await loadState(root, syncStreamId(cfg));
  const matcher = buildIgnoreMatcher(root, {
    respectGitignore: cfg.respectGitignore === true,
    forceTrackedEvaluation: true,
    protectTrackedPaths: true,
    knownGitRepos: Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
  });
  const cache = await HashCache.load(root);
  const local = await scanManifest(root, matcher, cache);
  await cache.save(root);
  const present = new Set(local.files.map((f) => f.path));
  const deleted = state.lastSyncedManifest.files.filter((entry) => !present.has(entry.path)).map((entry) => entry.path);
  const unsafe = deleted
    .map((p) => ({ path: p, repo: matcher.unevaluatedGitRepoForPath?.(p) }))
    .find((p): p is { path: string; repo: string } => p.repo !== undefined);
  if (unsafe) {
    throw new Error(
      `refusing purge: cannot evaluate tracked files for git repo ${unsafe.repo} (first affected path ${unsafe.path}). ` +
        `Fix that repo's .git/index and retry.`
    );
  }
  const purged = deleted.filter((p) => matcher.ignores(p)).sort();
  if (purged.length === 0) {
    console.log("purge dry-run: nothing to delete.");
    return;
  }
  const dirs = [...new Set(purged.map((p) => p.split("/")[0] ?? p))].slice(0, 12);
  console.log(`purge dry-run: ${purged.length} path${purged.length === 1 ? "" : "s"} would be deleted from other machines.`);
  console.log(`top-level: ${dirs.join(", ")}${dirs.length < new Set(purged.map((p) => p.split("/")[0] ?? p)).size ? ", ..." : ""}`);
  if (!opts.yes) {
    if (process.stdin.isTTY !== true) throw new Error("refusing headless purge without --yes");
    const ok = await promptConfirm({ message: "Purge these ignored paths from synced state?", default: false });
    if (!ok) {
      console.log("purge cancelled.");
      return;
    }
  }
  deps.allowMassDeletePush = opts.allowMassDelete === true;
  const res = await pushManifest(root, cfg, local, deps, 0, true);
  console.log(
    res.committed
      ? `purged ${purged.length} ignored path${purged.length === 1 ? "" : "s"} -> sequence ${res.sequence}`
      : `purge made no remote change (sequence ${res.sequence})`
  );
}

function parseOnOff(raw: string | undefined): boolean | undefined {
  if (raw === "on" || raw === "true") return true;
  if (raw === "off" || raw === "false") return false;
  return undefined;
}

function isSlashlessNegation(pattern: string): boolean {
  const p = pattern.trim();
  if (!p.startsWith("!") || p.startsWith("!!")) return false;
  const body = p.slice(1).replace(/^\/+/, "").replace(/\/+$/, "");
  return body.length > 0 && !body.includes("/");
}
