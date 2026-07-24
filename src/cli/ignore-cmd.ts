import fs from "node:fs/promises";
import path from "node:path";
import { buildIgnoreMatcher, effectiveIgnoreRules, HashCache, scanManifest } from "../engine/index.js";
import { loadConfig, loadState, saveConfig, syncStreamId } from "./config.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { confirmDestructive } from "./prompt.js";
import { localFileObservationForScan, makeDeferErrnoReporter, pushManifest } from "./sync.js";
import { deferManifest } from "./sync-recovery.js";
import { withWorkspaceSyncMutex } from "./sync-mutex.js";
import { style } from "./style.js";
import { savePathWarnings } from "./path-warnings.js";
import { summarizeCaseCollisions } from "./sync-cmd.js";

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
    console.warn("note: a negation pattern without a slash (like `!name`) makes rbox check every folder instead of skipping ignored ones — syncing stays correct, but scans of big trees can get slower.");
  }
  console.log(`(forward-only: already-synced matches keep their last copy on other machines and stop syncing.`);
  console.log(` to remove a file from all machines, delete it FIRST, let that sync, then ignore it.)`);
}

/** Print the ignore rule set, labeled by source and current activity, in precedence order. */
export async function listIgnoreRules(root: string, opts: { full?: boolean } = {}): Promise<void> {
  const cfg = await loadConfig(root);
  const respectGitignore = cfg.respectGitignore === true;
  const rules = effectiveIgnoreRules(root);
  console.log(`respectGitignore: ${respectGitignore ? "on" : "off"}`);
  console.log(`ignore rules (precedence: builtin → .gitignore → .rboxignore):`);
  const label = (source: (typeof rules)[number]["source"]): string => {
    if (source !== ".gitignore") return source;
    return respectGitignore ? ".gitignore ACTIVE" : ".gitignore present but NOT applied (respectGitignore off)";
  };
  if (opts.full) {
    for (const r of rules) console.log(`  [${label(r.source)}] ${r.pattern}`);
  } else {
    const builtinCount = rules.filter((r) => r.source === "builtin").length;
    console.log(`  [builtin] ${builtinCount} default patterns (node_modules, .git, build caches, …) — see them all with \`rbox ignore --list\``);
    for (const r of rules) if (r.source !== "builtin") console.log(`  [${label(r.source)}] ${r.pattern}`);
  }
  console.log(style.dim("add a pattern:  rbox ignore '<glob>'    ·    respect .gitignore: rbox ignore --respect-gitignore <on|off>"));
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
  const preview = await computePurgeCandidate(root, cfg);
  if (preview.purged.length === 0) {
    console.log("purge dry-run: nothing to delete.");
    return;
  }
  const topLevelDirs = new Set(preview.purged.map((p) => p.split("/")[0] ?? p));
  const dirs = [...topLevelDirs].slice(0, 12);
  console.log(`purge dry-run: ${preview.purged.length} path${preview.purged.length === 1 ? "" : "s"} would be deleted from other machines.`);
  console.log(`top-level: ${dirs.join(", ")}${dirs.length < topLevelDirs.size ? ", ..." : ""}`);
  const ok = await confirmDestructive({
    message: "Purge these ignored paths from synced state?",
    yes: opts.yes,
    default: false,
    headless: "require-yes",
    headlessError: "refusing headless purge without --yes",
  });
  if (!ok) {
    console.log("purge cancelled.");
    return;
  }

  await withWorkspaceSyncMutex(root, async (syncMutex) => {
    // The preview is presentation only. Recompute the final deletion set and
    // manifest after confirmation while holding the operation mutex.
    const final = await computePurgeCandidate(root, cfg);
    if (final.purged.length === 0) {
      console.log("purge made no remote change (the confirmed paths changed before the lock was acquired)");
      return;
    }
    deps.syncMutex = syncMutex;
    deps.allowMassDeletePush = opts.allowMassDelete === true;
    deps.onCaseCollisionObservation = async (observation) => {
      if (observation.authority === "authoritative") await savePathWarnings(root, observation.caseCollisions);
    };
    const res = await pushManifest(root, cfg, final.local, deps, {
      purgeIgnored: true,
      localFileObservation: localFileObservationForScan(final.observationComplete),
    });
    console.log(
      res.committed
        ? `purged ${final.purged.length} ignored path${final.purged.length === 1 ? "" : "s"} -> sequence ${res.sequence}`
        : `purge made no remote change (sequence ${res.sequence})`
    );
    summarizeCaseCollisions(res.caseCollisions);
  });
}

async function computePurgeCandidate(root: string, cfg: Awaited<ReturnType<typeof buildAuthedRemote>>["cfg"]): Promise<{ local: Awaited<ReturnType<typeof scanManifest>>; purged: string[]; observationComplete: boolean }> {
  const state = await loadState(root, syncStreamId(cfg));
  const matcher = buildIgnoreMatcher(root, {
    respectGitignore: cfg.respectGitignore === true,
    forceTrackedEvaluation: true,
    protectTrackedPaths: true,
    knownGitRepos: Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
  });
  const cache = await HashCache.load(root);
  const deferred = new Set<string>();
  const deferErrnos = makeDeferErrnoReporter();
  let local = await scanManifest(root, matcher, cache, undefined, undefined, undefined, deferred, undefined, undefined, undefined, deferErrnos.onErrno);
  deferErrnos.flush();
  // Design 108: a scan-faulted path is carried from base, never purged as absent.
  if (deferred.size > 0) local = deferManifest(local, state.lastSyncedManifest, deferred);
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
  return { local, purged, observationComplete: deferred.size === 0 };
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
