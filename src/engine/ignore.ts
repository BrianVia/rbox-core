import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import ignore from "ignore";

/**
 * Dev-aware defaults: regenerable state and secrets never leave the machine.
 * `.git/` is excluded here for the Phase-1 core; the mirror model treats it as
 * an atomic snapshot unit, handled separately (and intentionally not file-by-file).
 */
export const BUILTIN_IGNORE: string[] = [
  // No trailing slash: matches BOTH the `.git/` directory AND a `.git` FILE — a git
  // worktree/submodule checkout uses a `.git` pointer file whose target is a local
  // absolute path. Syncing it would materialize a dangling pointer on every other
  // machine (git state transfers via git-sync snapshots, never as raw files).
  ".git",
  ".rbox/",
  // No trailing slash for the same reason as `.git`: pnpm/worktree setups create
  // SYMLINKS named `node_modules` (observed 2026-08-13: three worktree symlinks
  // synced to the fleet and wedged a receiver — issue #659). A trailing slash
  // matches only real directories; the bare name matches any entry type at any
  // depth. No plausible user content shares this name.
  "node_modules",
  ".venv/",
  "venv/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".cache/",
  "coverage/",
  "target/",
  // Generated package-manager artifacts (hydration reconstructs these — design 08;
  // must be ignored or `rbox hydrate` output would be re-uploaded). NB: Yarn PnP's
  // `.yarn/` is intentionally committed by some projects, so it's NOT ignored here.
  ".pnpm-store/",
  "vendor/bundle/",
  // Regenerable build/dependency/cache dirs across ecosystems (curated from the
  // github/gitignore templates). Bar for inclusion: the name is DISTINCTIVE (no
  // plausible user content — which is why generic `bin/`, `obj/`, `out/`, `lib/`,
  // `deps/`, `pkg/` are deliberately absent) AND the contents are regenerable.
  // Sometimes-committed-on-purpose dirs (`Pods/`, plain `vendor/`, `.yarn/`) are
  // also deliberately absent. Editor config (`.vscode/`, `.idea/`) and experiment
  // data (`wandb/`, `mlruns/`) stay synced — untracked-but-precious is the point.
  ".build/", // SwiftPM (its checkouts/ contain dependency .git clones — git-sync noise)
  "DerivedData/", // Xcode
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".tox/",
  ".nox/",
  ".eggs/",
  ".ipynb_checkpoints/",
  "cdk.out/", // AWS CDK synth output
  ".terraform/", // provider binaries/modules (state FILES still sync — that's a feature)
  ".serverless/",
  ".gradle/",
  "_build/", // Elixir mix / Sphinx
  ".dart_tool/",
  ".expo/",
  ".vercel/",
  ".netlify/",
  ".firebase/",
  ".wrangler/", // Wrangler local dev state/cache
  ".output/", // Nuxt 3 / Nitro
  ".parcel-cache/",
  ".angular/",
  ".astro/",
  ".docusaurus/",
  "zig-cache/",
  "zig-out/",
  "cmake-build-*/", // CLion per-profile CMake output
  ".nyc_output/",
  ".sass-cache/",
  "storybook-static/",
  ".DS_Store",
  // Secrets: excluded by default; opt-in sync is E2EE-only (not in Phase 1).
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_ed25519",
  "*.sqlite",
  "*.sqlite3",
  "*.db",
  // rbox's own atomic-write temp files (see fsutil RBOX_TMP_PREFIX). A crashed
  // temp left beside a real file must never be scanned into a manifest.
  ".rbox-tmp-*",
  // ...but templates are safe to sync.
  "!.env.example",
  "!.env.sample",
  "!.env.template",
];

/**
 * The COARSE subset of {@link BUILTIN_IGNORE} that is safe to hard-prune at the
 * OS-watcher level: pure directory excludes with **no negation / re-include**
 * counterpart anywhere in the rule set. A native watcher (e.g. `@parcel/watcher`)
 * is fed *only* these — as a volume optimization so it never watches the huge
 * regenerable subtrees — while the full {@link IgnoreMatcher} stays the
 * AUTHORITATIVE post-filter on every delivered event (see design §41). A path
 * that a `.rboxignore` `!negation` re-includes lives outside these dirs, so
 * pruning them can never hide an event the matcher would keep.
 *
 * Deliberately excludes file-level patterns (`.env`, `*.key`, `.DS_Store`, and the
 * `!.env.example` negations): those must reach the JS matcher, not be silently
 * dropped by a coarse native filter.
 */
export const HARD_PRUNE_DIRS: string[] = [
  "node_modules",
  ".git",
  ".rbox",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "coverage",
  "target",
  ".pnpm-store",
  // The big regenerable dirs from the curated set above (literal names only —
  // `cmake-build-*` is a glob and stays matcher-side).
  ".build",
  "DerivedData",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  "cdk.out",
  ".terraform",
  ".gradle",
  "_build",
  ".dart_tool",
  ".parcel-cache",
  ".angular",
  "zig-cache",
  "zig-out",
];

/** Hard-prune dirs that are effectively never user-re-includable, so they stay safe to
 *  hand a native watcher's coarse `ignore` even in the presence of negations. `.rbox` is
 *  hard-excluded in code (no rule can re-include it); a `!node_modules/…`/`!.git/…`
 *  re-include is pathological and still heals via the safety scan. */
export const ALWAYS_NATIVE_PRUNE: ReadonlySet<string> = new Set(["node_modules", ".git", ".rbox"]);

/**
 * True when a POSIX workspace-relative path is a ref-surface signal inside an
 * in-tree Git control directory. This is deliberately independent of the sync
 * ignore matcher: `.git` remains hard-excluded from manifests while the native
 * watcher may use these paths only to request a git-aware push.
 */
const RBOX_SCRATCH_REF_RE = /^refs\/rbox-[^/]*(?:\/|$)/;

/**
 * The committed Git ref surface observed by both the workspace watcher and the
 * Linux ref side-channel. Keep this data-only table as the single source of
 * truth: the two classifiers deliberately have different path inputs, but must
 * never drift on which committed names are signals.
 */
export const GIT_REF_SIGNAL_TAIL_TABLE = {
  gitDir: { targets: ["HEAD"], structures: [] },
  commonDir: { targets: ["packed-refs"], structures: ["refs"] },
  refsRoot: { targets: ["stash"], structures: ["heads", "tags"] },
  refsNamespace: { parents: ["refs/heads", "refs/tags"] },
} as const;

/** True for a committed-state target relative to a Git control directory. */
export function isGitRefSignalTail(tail: string): boolean {
  if (tail.length === 0 || tail.endsWith(".lock")) return false;
  if (tail === "reftable" || tail.startsWith("reftable/")) return false;
  if (tail === "refs/remotes" || tail.startsWith("refs/remotes/")) return false;
  if (RBOX_SCRATCH_REF_RE.test(tail)) return false;
  return (GIT_REF_SIGNAL_TAIL_TABLE.gitDir.targets as readonly string[]).includes(tail)
    || (GIT_REF_SIGNAL_TAIL_TABLE.commonDir.targets as readonly string[]).includes(tail)
    || tail.startsWith("refs/") && (GIT_REF_SIGNAL_TAIL_TABLE.refsRoot.targets as readonly string[]).includes(tail.slice("refs/".length))
    || GIT_REF_SIGNAL_TAIL_TABLE.refsNamespace.parents.some((root) => tail.startsWith(`${root}/`) && tail.length > root.length + 1);
}

function isSignalTail(parts: string[], start: number): boolean {
  return isGitRefSignalTail(parts.slice(start).join("/"));
}

export function isGitRefSignal(relPath: string): boolean {
  // Fast bail for the hot path: this runs on EVERY watcher event, and almost
  // all paths contain no ".git" segment at all — skip the split/scan for them.
  if (!relPath.includes(".git")) return false;

  const parts = relPath.split("/");

  for (let dotGit = 0; dotGit < parts.length; dotGit++) {
    if (parts[dotGit] !== ".git") continue;

    // Ordinary repository control directory: <repo>/.git/<tail>.
    if (isSignalTail(parts, dotGit + 1)) return true;

    // Linked-worktree control directory: <repo>/.git/worktrees/<name>/<tail>.
    if (parts[dotGit + 1] === "worktrees" && parts[dotGit + 2] && isSignalTail(parts, dotGit + 3)) return true;

    // Submodule control directories, including nested module chains:
    // <base>/.git/modules/<name>[/modules/<nested>].../<tail>.
    if (parts[dotGit + 1] !== "modules" || !parts[dotGit + 2]) continue;
    let tailStart = dotGit + 3;
    if (isSignalTail(parts, tailStart)) return true;
    while (parts[tailStart] === "modules" && parts[tailStart + 1]) {
      tailStart += 2;
      if (isSignalTail(parts, tailStart)) return true;
    }
  }
  return false;
}

/**
 * Globs for a native watcher's coarse `ignore` (design §41). Honors negations: a
 * hard-prune dir the user could RE-INCLUDE under (e.g. a `.rboxignore` `!dist/keep.txt`
 * or a bare `!keep.txt`) is DROPPED from the native set, so its live events still reach
 * the AUTHORITATIVE JS {@link IgnoreMatcher} instead of being silently pruned before the
 * matcher ever sees them. Each kept dir is pruned at every depth INCLUDING its children:
 * `**​/d` matches the directory itself, `**​/d/**` its whole subtree (a native watcher
 * emits child paths, so the subtree glob is required to keep them off the JS hot path).
 */
export function nativePruneGlobs(root: string): string[] {
  const negations = effectiveIgnoreRules(root)
    .filter((r) => r.pattern.startsWith("!"))
    .map((r) => r.pattern.slice(1).replace(/^\/+/, "").replace(/\/+$/, ""));
  const dirs = HARD_PRUNE_DIRS.filter(
    (d) => d !== ".git" && (ALWAYS_NATIVE_PRUNE.has(d) || !negations.some((neg) => negationReenters(neg, d)))
  );
  return [
    ...dirs.flatMap((d) => [`**/${d}`, `**/${d}/**`]),
    // Watcher-only Git seam: descend into `.git` for ref signals, but keep the
    // two unambiguous top-level high-volume stores out of the native watch.
    "**/.git/objects",
    "**/.git/objects/**",
    "**/.git/logs",
    "**/.git/logs/**",
  ];
}

/**
 * Whether every directory excluded by the native watcher is also excluded by the
 * authoritative matcher. A false result means the matcher requires events from a
 * subtree the native subscription can never deliver; no scan can make that
 * subscription safe to trust.
 */
export function nativePruneCoverageComplete(
  root: string,
  admission: readonly string[],
  matcher: IgnoreMatcher,
): boolean {
  const reenteredDirs = effectiveIgnoreRules(root)
    .filter((rule) => rule.pattern.startsWith("!") && !rule.pattern.startsWith("!!"))
    .map((rule) => rule.pattern.slice(1).replace(/^\/+/, "").replace(/\/+$/, ""));
  return HARD_PRUNE_DIRS.every((dir) => {
    const nativelyPruned = admission.includes(`**/${dir}`) && admission.includes(`**/${dir}/**`);
    if (!nativelyPruned) return true;
    // Hard exclusions are outside matcher policy: no user rule can require their
    // contents. For overridable directories, native globs match at every depth,
    // so any path-aware negation is a conflict even when the root instance stays
    // ignored (for example `!src/node_modules/keep.js`).
    if (isHardExcluded(`${dir}/`)) return true;
    const reentered = reenteredDirs.some((negation) => negationReenters(negation, dir));
    return !reentered && (matcher.prunes?.(`${dir}/`) ?? matcher.ignores(`${dir}/`));
  });
}

/**
 * Could a `!negation` (leading `!` and surrounding slashes already stripped by the caller)
 * re-include the directory `d` such that we must NOT native-prune it? PATH-AWARE: a
 * negation only re-enters `d` if it is anchored to that specific directory —
 *   - `d` itself (`!dist/` → `dist`, or bare `!dist`): re-includes the dir entry;
 *   - `d/…` (`!dist/keep.txt`): targets a path under the dir;
 *   - `…/d/…` (`!src/dist/x`): targets a nested occurrence the any-depth prune glob catches.
 *
 * A BARE-BASENAME negation with no slash whose name isn't a hard-prune dir (`!.env.example`,
 * `!keep.txt`) matches files by name anywhere and must NOT un-prune dist/build/etc. — those
 * built-in `!.env.*` negations would otherwise regress every build dir back to being watched.
 * (Accepted consequence: a re-included file that happens to sit *inside* a hard-pruned dir —
 * e.g. `dist/.env.example` via `!.env.example` — is healed by the 60s safety scan rather than
 * delivered as a live event.)
 */
function negationReenters(neg: string, d: string): boolean {
  if (neg.length === 0) return false;
  return neg === d || neg.startsWith(`${d}/`) || neg.includes(`/${d}/`) || neg.endsWith(`/${d}`);
}

export interface IgnoreMatcher {
  /** `relPath` is POSIX-relative; pass a trailing slash for directories. */
  ignores(relPath: string): boolean;
  /** Directory-prune verdict for file scans. More conservative than `ignores` when
   *  a workspace-level `.rboxignore` negation may rescue a descendant. */
  prunes?(relPath: string): boolean;
  /** Directory-prune verdict for git-repo discovery. This is always gitignore-aware,
   *  even when full file-sync honoring is off. */
  prunesForGitDiscovery?(relPath: string): boolean;
  /** True when `relPath` is known tracked by the nearest containing git repo. */
  tracked?(relPath: string): boolean;
  /** The base-manifest repo under `relPath` whose tracked set could not be evaluated,
   *  if any. Used by destructive purge safety. */
  unevaluatedGitRepoForPath?(relPath: string): string | undefined;
}

export interface BuildIgnoreMatcherOptions {
  /** Extra top-layer rules, kept for the existing test seam. */
  extra?: string[];
  /** Machine-local, root-relative literal path prefixes from the folder config. */
  ignorePaths?: string[];
  /** Opt-in design-72 file-sync behavior: nested `.gitignore` rules exclude only
   *  gitignored + untracked paths. */
  respectGitignore?: boolean;
  /** Build tracked sets even when gitignore file-sync filtering is off. Used by
   *  destructive purge checks, where trackedness is a safety guard independent of
   *  the workspace setting. */
  forceTrackedEvaluation?: boolean;
  /** When tracked evaluation is forced for purge, tracked files must not be dropped
   *  by any overridable ignore rule. Hard excludes still win. */
  protectTrackedPaths?: boolean;
  /** Repos already present in the base manifest; consulted even if discovery is
   *  pruned by an ignored parent. */
  knownGitRepos?: string[];
}

/** Is `rel` a file whose CONTENT defines the ignore rules? Any change to one
 *  invalidates every matcher built before it (daemon watch events, pulled
 *  writes/deletes) — callers must rebuild before trusting another verdict. */
export const isIgnoreRuleFile = (rel: string): boolean =>
  rel === ".rboxignore" || rel.endsWith("/.rboxignore") || rel === ".gitignore" || rel.endsWith("/.gitignore");

/**
 * Paths that are excluded UNCONDITIONALLY — no `.rboxignore`/`.gitignore`
 * negation (`!.rbox`, `!.git`) and no `--purge` can re-include them (design 12, C8).
 * `.rbox/` holds `state.json` with the DECRYPTED base manifest; letting it into a
 * synced tree would leak the very metadata E2EE hides. `.git` (any depth, file OR
 * dir) is equally non-negotiable: git state transfers ONLY via git-sync snapshots —
 * a raw `.git` tree synced file-by-file arrives torn/corrupt, and a worktree
 * pointer file carries a machine-local absolute path. A stray `!.git` in a
 * project's `.gitignore` must not switch that hazard back on. Checked BEFORE the
 * overridable `ignore` ruleset, so it always wins.
 */
function isHardExcluded(relPath: string): boolean {
  const p = relPath.replace(/\/+$/, ""); // tolerate a trailing slash (dir form)
  if (p === ".rbox" || p.startsWith(".rbox/") || p.endsWith("/.rbox") || p.includes("/.rbox/")) return true;
  return p === ".git" || p.startsWith(".git/") || p.endsWith("/.git") || p.includes("/.git/");
}

export { isHardExcluded };

type IgnoreInstance = ReturnType<typeof ignore>;
type RuleSource = "legacy" | ".gitignore" | ".rboxignore";

interface GitRuleLayer {
  base: string;
  ig: IgnoreInstance;
}

interface TrackedRepoSet {
  relPath: string;
  paths: Set<string>;
  dirPrefixes: Set<string>;
  known: boolean;
  available: boolean;
}

type RuleDecision = { ignored: boolean; source: RuleSource };

function matcherOptions(extraOrOptions: string[] | BuildIgnoreMatcherOptions): Required<BuildIgnoreMatcherOptions> {
  if (Array.isArray(extraOrOptions)) {
    return { extra: extraOrOptions, ignorePaths: [], respectGitignore: false, forceTrackedEvaluation: false, protectTrackedPaths: false, knownGitRepos: [] };
  }
  return {
    extra: extraOrOptions.extra ?? [],
    ignorePaths: extraOrOptions.ignorePaths ?? [],
    respectGitignore: extraOrOptions.respectGitignore === true,
    forceTrackedEvaluation: extraOrOptions.forceTrackedEvaluation === true,
    protectTrackedPaths: extraOrOptions.protectTrackedPaths === true,
    knownGitRepos: extraOrOptions.knownGitRepos ?? [],
  };
}

export function buildIgnoreMatcher(root: string, extraOrOptions: string[] | BuildIgnoreMatcherOptions = []): IgnoreMatcher {
  const opts = matcherOptions(extraOrOptions);
  const rootGitignoreText = readIfExists(path.join(root, ".gitignore"));
  const legacyIg = ignore().add(BUILTIN_IGNORE);
  if (rootGitignoreText) legacyIg.add(rootGitignoreText);
  const rootGitIg = ignore();
  if (rootGitignoreText) rootGitIg.add(rootGitignoreText);
  const configLines = opts.ignorePaths.map(normalizeIgnorePath).filter((rule): rule is string => rule !== undefined);
  const rboxLines = [...ruleLines(readIfExists(path.join(root, ".rboxignore"))), ...configLines, ...opts.extra];
  legacyIg.add(rboxLines);
  const rboxIg = ignore().add(rboxLines);
  const rboxNegations = negationInfos(rboxLines);
  const slashlessRboxNegation = rboxNegations.some((n) => n.slashless);
  const protectedPrefixes = rboxNegations.map((n) => n.staticPrefix).filter((p): p is string => Boolean(p));
  const gitLayers = new Map<string, GitRuleLayer | undefined>();
  const knownRepoRelSet = new Set(opts.knownGitRepos.map(normalizeRepoRel));
  const trackedEvaluationEnabled = opts.respectGitignore || opts.forceTrackedEvaluation || opts.protectTrackedPaths;
  let trackedRepos: TrackedRepoSet[] = [];

  const getGitLayer = (base: string): GitRuleLayer | undefined => {
    const key = normalizeRepoRel(base);
    if (gitLayers.has(key)) return gitLayers.get(key);
    const rel = key === "." ? "" : key;
    const text = key === "." ? rootGitignoreText : readIfExists(path.join(root, rel, ".gitignore"));
    const layer = text ? { base: rel, ig: ignore().add(text) } : undefined;
    gitLayers.set(key, layer);
    return layer;
  };

  const testLayer = (ig: IgnoreInstance, relPath: string): boolean | undefined => {
    if (!relPath) return undefined;
    const res = ig.test(relPath);
    if (res.ignored) return true;
    if (res.unignored) return false;
    return undefined;
  };

  const rootGitDecision = (relPath: string): boolean | undefined => {
    const { clean, isDir } = normalizeRel(relPath);
    if (!clean) return undefined;
    return testLayer(rootGitIg, clean + (isDir ? "/" : ""));
  };

  const nestedGitDecision = (relPath: string): boolean | undefined => {
    const { clean, isDir } = normalizeRel(relPath);
    if (!clean) return undefined;
    const bases = gitCandidateBases(clean, isDir).filter(Boolean);
    const loaded: GitRuleLayer[] = [];
    let decision: boolean | undefined;
    for (const base of bases) {
      if (base) {
        const baseIgnored = evaluateGitLayers(loaded, `${base}/`);
        if (baseIgnored === true) break; // git's "cannot re-include below an excluded parent"
      }
      const layer = getGitLayer(base);
      if (!layer) continue;
      loaded.push(layer);
      const local = localPathForBase(clean, isDir, layer.base);
      const d = testLayer(layer.ig, local);
      if (d !== undefined) decision = d;
    }
    return decision;
  };

  const legacyDecision = (relPath: string): RuleDecision | undefined => {
    const { clean, isDir } = normalizeRel(relPath);
    if (!clean) return undefined;
    const normalized = clean + (isDir ? "/" : "");
    const ignored = testLayer(legacyIg, normalized);
    if (ignored === undefined) return undefined;
    const rbox = testLayer(rboxIg, normalized);
    const rootGit = rootGitDecision(normalized);
    const source: RuleSource = ignored && rbox === true ? ".rboxignore" : rootGit === true ? ".gitignore" : "legacy";
    return { ignored, source };
  };

  const rboxNegationRescues = (relPath: string): boolean => {
    if (rboxNegations.length === 0) return false;
    const { clean, isDir } = normalizeRel(relPath);
    if (!clean) return false;
    const normalized = clean + (isDir ? "/" : "");
    const direct = testLayer(rboxIg, normalized);
    if (direct === true) return false;
    if (direct === false) return true;

    const parts = clean.split("/");
    for (let i = parts.length; i >= 1; i--) {
      const ancestor = `${parts.slice(0, i).join("/")}/`;
      const ancestorDecision = testLayer(rboxIg, ancestor);
      if (ancestorDecision === true) return false;
      if (ancestorDecision === false) return true;
    }
    return false;
  };

  const evaluateGitLayers = (layers: GitRuleLayer[], relPath: string): boolean | undefined => {
    const { clean, isDir } = normalizeRel(relPath);
    let decision: boolean | undefined;
    for (const layer of layers) {
      const local = localPathForBase(clean, isDir, layer.base);
      const d = testLayer(layer.ig, local);
      if (d !== undefined) decision = d;
    }
    return decision;
  };

  const isTracked = (relPath: string): boolean => {
    if (!trackedEvaluationEnabled || trackedRepos.length === 0) return false;
    const { clean, isDir } = normalizeRel(relPath);
    if (!clean || isDir) return false;
    for (const repo of trackedRepos) {
      const local = repoLocalPath(repo.relPath, clean);
      if (local === undefined) continue;
      if (!repo.available) return true; // fail closed: unknown means "possibly tracked"
      if (repo.paths.has(local)) return true;
    }
    return false;
  };

  const dirMayContainTrackedPath = (relPath: string): boolean => {
    if (!trackedEvaluationEnabled || trackedRepos.length === 0) return false;
    const { clean } = normalizeRel(relPath);
    if (!clean) return false;
    for (const repo of trackedRepos) {
      if (!repo.available) {
        if (dirIntersectsRepo(clean, repo.relPath)) return true;
        continue;
      }
      for (const prefix of repo.dirPrefixes) {
        if (prefix === clean || prefix.startsWith(`${clean}/`)) return true;
      }
    }
    return false;
  };

  const fullDecision = (relPath: string, nestedGitignore: boolean): RuleDecision | undefined => {
    const { clean, isDir } = normalizeRel(relPath);
    if (!clean) return undefined;
    const normalized = clean + (isDir ? "/" : "");
    let decision = legacyDecision(normalized);
    if (nestedGitignore) {
      const nested = nestedGitDecision(normalized);
      if (nested === true) decision = rboxNegationRescues(normalized) ? { ignored: false, source: ".rboxignore" } : { ignored: true, source: ".gitignore" };
      if (decision?.ignored === true && rboxNegationRescues(normalized)) decision = { ignored: false, source: ".rboxignore" };
    }
    return decision;
  };

  const ignores = (relPath: string): boolean => {
    const { clean, isDir } = normalizeRel(relPath);
    if (!clean) return false; // `ignore` throws on an empty path; root itself is never a candidate.
    if (isHardExcluded(clean + (isDir ? "/" : ""))) return true;
    const nested = opts.respectGitignore;
    const decision = fullDecision(clean + (isDir ? "/" : ""), nested);
    if (!isDir && decision?.ignored === true) {
      const tracked = isTracked(clean);
      // Purge protects tracked paths from rules rbox INFERRED (builtin, .gitignore),
      // never from `.rboxignore` — the human's own synced instruction. Protecting
      // those made every tracked file permanently unpurgeable (#838). An UNREADABLE
      // repo still fails closed, via `unevaluatedGitRepoForPath`, not here.
      if (opts.protectTrackedPaths && tracked && decision.source !== ".rboxignore") return false;
      if (opts.respectGitignore && decision.source === ".gitignore" && tracked) return false;
    }
    return decision?.ignored === true;
  };

  const prunes = (relPath: string): boolean => {
    const { clean } = normalizeRel(relPath);
    if (!clean) return false;
    const dirRel = `${clean}/`;
    if (isHardExcluded(dirRel)) return true;
    const decision = fullDecision(dirRel, opts.respectGitignore);
    if (decision?.ignored !== true) return false;
    if (dirMayContainTrackedPath(clean)) return false;
    if (opts.respectGitignore && decision.source === ".gitignore") {
      if (slashlessRboxNegation) return false;
      if (protectedPrefixes.some((prefix) => dirContainsProtectedPrefix(clean, prefix))) return false;
    }
    return true;
  };

  const prunesForGitDiscovery = (relPath: string): boolean => {
    const { clean } = normalizeRel(relPath);
    if (!clean) return false;
    const dirRel = `${clean}/`;
    if (isHardExcluded(dirRel)) return true;
    return fullDecision(dirRel, true)?.ignored === true;
  };

  const unevaluatedGitRepoForPath = (relPath: string): string | undefined => {
    const { clean } = normalizeRel(relPath);
    if (!clean) return undefined;
    for (const repo of trackedRepos) {
      if (!repo.known || repo.available) continue;
      if (repoLocalPath(repo.relPath, clean) !== undefined) return repo.relPath;
    }
    return undefined;
  };

  const matcher: IgnoreMatcher = { ignores, prunes, prunesForGitDiscovery, tracked: isTracked, unevaluatedGitRepoForPath };
  if (trackedEvaluationEnabled) {
    for (const rel of discoverGitReposSync(root, prunesForGitDiscovery)) knownRepoRelSet.add(normalizeRepoRel(rel));
    trackedRepos = [...knownRepoRelSet]
      .map((rel) => loadTrackedRepoSet(root, rel, opts.knownGitRepos.map(normalizeRepoRel).includes(rel)))
      .sort((a, b) => repoDepth(b.relPath) - repoDepth(a.relPath));
  }
  return matcher;
}

function readIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function ruleLines(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Validate one machine-local literal path prefix and return its anchored matcher rule. */
export function normalizeIgnorePath(value: string): string | undefined {
  if (value.length === 0 || value.trim() !== value) return undefined;
  if (value.includes("\0") || value.includes("\n") || value.includes("\r") || value.includes("\\") || value.startsWith("/") || value.startsWith("~") || value.startsWith("!")) return undefined;
  if (/[*?[\]{}]/.test(value)) return undefined;
  const cleaned = value.endsWith("/") ? value.slice(0, -1) : value;
  if (cleaned.length === 0 || cleaned.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return `/${cleaned}`;
}

interface NegationInfo {
  slashless: boolean;
  staticPrefix?: string;
}

function negationInfos(lines: string[]): NegationInfo[] {
  const out: NegationInfo[] = [];
  for (const line of lines) {
    if (!line.startsWith("!") || line.startsWith("!!")) continue;
    const raw = line.slice(1).replace(/^\/+/, "").replace(/\/+$/, "");
    if (!raw) continue;
    const slashless = !raw.includes("/");
    out.push({ slashless, staticPrefix: slashless ? undefined : staticPrefix(raw) });
  }
  return out;
}

function staticPrefix(pattern: string): string | undefined {
  const parts: string[] = [];
  for (const part of pattern.split("/")) {
    if (!part || /[*?[\]{}()]/.test(part)) break;
    parts.push(part);
  }
  return parts.length ? parts.join("/") : undefined;
}

function dirContainsProtectedPrefix(dirRel: string, prefix: string): boolean {
  const dir = dirRel.replace(/\/+$/, "");
  const p = prefix.replace(/\/+$/, "");
  return p === dir || p.startsWith(`${dir}/`) || dir.startsWith(`${p}/`);
}

function dirIntersectsRepo(dirRel: string, repoRel: string): boolean {
  if (repoRel === ".") return true;
  return dirRel === repoRel || dirRel.startsWith(`${repoRel}/`) || repoRel.startsWith(`${dirRel}/`);
}

function normalizeRel(relPath: string) {
  const isDir = relPath.endsWith("/");
  const clean = relPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return { clean, isDir };
}

function gitCandidateBases(clean: string, isDir: boolean): string[] {
  const parts = clean.split("/");
  const parentDepth = Math.max(0, parts.length - 1);
  const max = isDir ? Math.max(0, parentDepth) : parentDepth;
  const bases = [""];
  for (let i = 1; i <= max; i++) bases.push(parts.slice(0, i).join("/"));
  return bases;
}

function localPathForBase(clean: string, isDir: boolean, base: string): string {
  const local = base ? clean.slice(base.length + 1) : clean;
  return local + (isDir ? "/" : "");
}

function normalizeRepoRel(rel: string): string {
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return clean === "" ? "." : clean;
}

function repoDepth(rel: string): number {
  return rel === "." ? 0 : rel.split("/").length;
}

function repoLocalPath(repoRel: string, cleanRel: string): string | undefined {
  if (repoRel === ".") return cleanRel;
  return cleanRel === repoRel ? "" : cleanRel.startsWith(`${repoRel}/`) ? cleanRel.slice(repoRel.length + 1) : undefined;
}

function discoverGitReposSync(root: string, prunesForDir: (relPath: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = rel ? path.join(root, rel) : root;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    const dotGit = entries.find((e) => e.name === ".git");
    if (dotGit?.isDirectory() || dotGit?.isFile()) out.push(rel || ".");
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (prunesForDir(`${childRel}/`)) continue;
      walk(childRel);
    }
  };
  walk("");
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Two outcomes, never one (design 224 §2.1). `indexUnreadable` keeps the historic
 * fail-open (`available: false` ⇒ "possibly tracked" ⇒ un-ignored and unprunable).
 * `indexAbsent` — a repo that git resolved, whose index is genuinely `ENOENT`, and
 * which has NO commits — has an EMPTY tracked set, not an unknown one, so it must
 * not un-ignore its own `node_modules`/`venv`/`.env`.
 *
 * All three signals are load-bearing. A repo that HAS commits but whose index was
 * deleted also yields ∅ from `git ls-files --cached`, yet its true tracked set is
 * non-empty; classifying it `indexAbsent` would let `rbox ignore --purge` delete
 * committed files fleet-wide.
 */
function loadTrackedRepoSet(root: string, relPath: string, known: boolean): TrackedRepoSet {
  const repoDir = relPath === "." ? root : path.join(root, relPath);
  const indexUnreadable = (): TrackedRepoSet => ({ relPath, paths: new Set(), dirPrefixes: new Set(), known, available: false });
  const indexPath = gitOutput(repoDir, ["rev-parse", "--git-path", "index"]);
  if (!indexPath) return indexUnreadable();
  const resolvedIndex = path.resolve(repoDir, indexPath);
  const st = safeStat(resolvedIndex);
  if (st.kind === "absent") {
    const unbornHead = gitOutput(repoDir, ["rev-parse", "--quiet", "--verify", "HEAD"]) === undefined;
    return unbornHead ? availableTrackedRepo(relPath, [], known) : indexUnreadable();
  }
  if (st.kind === "error") return indexUnreadable();
  const cacheFile = trackedCachePath(root, relPath, resolvedIndex);
  const cached = readTrackedCache(cacheFile, resolvedIndex, st.mtimeMs, st.size);
  if (cached.kind === "corrupt") return indexUnreadable();
  if (cached.kind === "hit") return availableTrackedRepo(relPath, cached.paths, known);
  const raw = gitOutput(repoDir, ["ls-files", "-z", "--cached"]);
  if (raw === undefined) return indexUnreadable();
  const paths = raw.split("\0").filter(Boolean).map((p) => p.replace(/\\/g, "/"));
  writeTrackedCache(cacheFile, { version: 1, indexPath: resolvedIndex, mtimeMs: st.mtimeMs, size: st.size, paths });
  return availableTrackedRepo(relPath, paths, known);
}

function availableTrackedRepo(relPath: string, paths: string[], known: boolean): TrackedRepoSet {
  return { relPath, paths: new Set(paths), dirPrefixes: trackedDirPrefixes(relPath, paths), known, available: true };
}

function trackedDirPrefixes(repoRel: string, paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const localPath of paths) {
    const clean = localPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!clean) continue;
    const workspacePath = repoRel === "." ? clean : `${repoRel}/${clean}`;
    const parts = workspacePath.split("/");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return out;
}

/** Errno-aware stat: `absent` is ENOENT SPECIFICALLY, and is the only stat outcome
 *  that can positively classify a missing index. Every other failure is `error`. */
type SafeStatResult = { kind: "ok"; mtimeMs: number; size: number } | { kind: "absent" } | { kind: "error" };

function safeStat(filePath: string): SafeStatResult {
  try {
    const st = fs.statSync(filePath);
    return { kind: "ok", mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "absent" } : { kind: "error" };
  }
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (res.status !== 0) return undefined;
  return res.stdout.endsWith("\n") ? res.stdout.slice(0, -1) : res.stdout;
}

interface TrackedCacheFile {
  version: 1;
  indexPath: string;
  mtimeMs: number;
  size: number;
  paths: string[];
}

function trackedCachePath(root: string, relPath: string, indexPath: string): string {
  const key = crypto.createHash("sha256").update(`${relPath}\0${indexPath}`).digest("hex");
  return path.join(root, ".rbox", "state", "git-tracked", `${key}.json`);
}

type TrackedCacheRead = { kind: "hit"; paths: string[] } | { kind: "miss" } | { kind: "corrupt" };

function readTrackedCache(filePath: string, indexPath: string, mtimeMs: number, size: number): TrackedCacheRead {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "miss" } : { kind: "corrupt" };
  }
  try {
    const parsed = JSON.parse(raw) as TrackedCacheFile;
    if (parsed.version !== 1) return { kind: "corrupt" };
    if (parsed.indexPath !== indexPath || parsed.mtimeMs !== mtimeMs || parsed.size !== size) return { kind: "miss" };
    if (!Array.isArray(parsed.paths) || parsed.paths.some((p) => typeof p !== "string")) return { kind: "corrupt" };
    return { kind: "hit", paths: parsed.paths.map((p) => p.replace(/\\/g, "/")) };
  } catch {
    return { kind: "corrupt" };
  }
}

function writeTrackedCache(filePath: string, data: TrackedCacheFile): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, filePath);
  } catch {
    // A cache miss next scan is safe; trackedness falls back to the fresh git output above.
  }
}

export interface IgnoreRule {
  source: "builtin" | ".gitignore" | ".rboxignore" | "config";
  pattern: string;
}

/** The effective rule set in precedence order (later overrides earlier; a
 *  `.rboxignore` `!negation` can re-include a builtin/gitignore-excluded path). */
export function effectiveIgnoreRules(root: string, ignorePaths: readonly string[] = []): IgnoreRule[] {
  const rules: IgnoreRule[] = BUILTIN_IGNORE.map((pattern) => ({ source: "builtin" as const, pattern }));
  const fromFile = (rel: string, source: IgnoreRule["source"]) => {
    const text = readIfExists(path.join(root, rel));
    if (!text) return;
    for (const line of text.split("\n")) {
      const p = line.trim();
      if (p && !p.startsWith("#")) rules.push({ source, pattern: p });
    }
  };
  fromFile(".gitignore", ".gitignore");
  fromFile(".rboxignore", ".rboxignore");
  for (const value of ignorePaths) {
    const pattern = normalizeIgnorePath(value);
    if (pattern !== undefined) rules.push({ source: "config", pattern });
  }
  return rules;
}
