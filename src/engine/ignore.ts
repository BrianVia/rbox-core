import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";

/**
 * Dev-aware defaults: regenerable state and secrets never leave the machine.
 * `.git/` is excluded here for the Phase-1 core; the mirror model treats it as
 * an atomic snapshot unit, handled separately (and intentionally not file-by-file).
 */
export const BUILTIN_IGNORE: string[] = [
  ".git/",
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

export interface IgnoreMatcher {
  /** `relPath` is POSIX-relative; pass a trailing slash for directories. */
  ignores(relPath: string): boolean;
}

/**
 * Paths that are excluded UNCONDITIONALLY — no `.rboxignore`/`.gitignore`
 * negation (`!.rbox`) and no `--purge` can re-include them (design 12, C8).
 * `.rbox/` holds `state.json` with the DECRYPTED base manifest; letting it into a
 * synced tree would leak the very metadata E2EE hides. Checked BEFORE the
 * overridable `ignore` ruleset, so it always wins.
 */
function isHardExcluded(relPath: string): boolean {
  const p = relPath.replace(/\/+$/, ""); // tolerate a trailing slash (dir form)
  return p === ".rbox" || p.startsWith(".rbox/");
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
