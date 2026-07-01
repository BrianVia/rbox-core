import fs from "node:fs";
import path from "node:path";
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
  "node_modules/",
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
];

/** Hard-prune dirs that are effectively never user-re-includable, so they stay safe to
 *  hand a native watcher's coarse `ignore` even in the presence of negations. `.rbox` is
 *  hard-excluded in code (no rule can re-include it); a `!node_modules/…`/`!.git/…`
 *  re-include is pathological and still heals via the safety scan. */
const ALWAYS_NATIVE_PRUNE = new Set(["node_modules", ".git", ".rbox"]);

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
    (d) => ALWAYS_NATIVE_PRUNE.has(d) || !negations.some((neg) => negationReenters(neg, d))
  );
  return dirs.flatMap((d) => [`**/${d}`, `**/${d}/**`]);
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
  return neg === d || neg.startsWith(`${d}/`) || neg.includes(`/${d}/`);
}

export interface IgnoreMatcher {
  /** `relPath` is POSIX-relative; pass a trailing slash for directories. */
  ignores(relPath: string): boolean;
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
  if (p === ".rbox" || p.startsWith(".rbox/")) return true;
  return p === ".git" || p.startsWith(".git/") || p.endsWith("/.git") || p.includes("/.git/");
}

export function buildIgnoreMatcher(root: string, extra: string[] = []): IgnoreMatcher {
  const ig = ignore().add(BUILTIN_IGNORE);
  const gitignore = readIfExists(path.join(root, ".gitignore"));
  if (gitignore) ig.add(gitignore);
  const rboxignore = readIfExists(path.join(root, ".rboxignore"));
  if (rboxignore) ig.add(rboxignore);
  ig.add(extra);
  // `ignore` throws on an empty path; the root itself is never a candidate.
  // The hard-exclude short-circuit runs first so no user rule can re-include `.rbox/`.
  return { ignores: (relPath) => relPath.length > 0 && (isHardExcluded(relPath) || ig.ignores(relPath)) };
}

function readIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export interface IgnoreRule {
  source: "builtin" | ".gitignore" | ".rboxignore";
  pattern: string;
}

/** The effective rule set in precedence order (later overrides earlier; a
 *  `.rboxignore` `!negation` can re-include a builtin/gitignore-excluded path). */
export function effectiveIgnoreRules(root: string): IgnoreRule[] {
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
  return rules;
}
