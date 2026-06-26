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

export function buildIgnoreMatcher(root: string, extra: string[] = []): IgnoreMatcher {
  const ig = ignore().add(BUILTIN_IGNORE);
  const gitignore = readIfExists(path.join(root, ".gitignore"));
  if (gitignore) ig.add(gitignore);
  const rboxignore = readIfExists(path.join(root, ".rboxignore"));
  if (rboxignore) ig.add(rboxignore);
  ig.add(extra);
  // `ignore` throws on an empty path; the root itself is never a candidate.
  return { ignores: (relPath) => relPath.length > 0 && ig.ignores(relPath) };
}

function readIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}
