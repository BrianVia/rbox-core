/**
 * Scope prefixes — the pure normalization/validation half of design 212 §3.1.
 *
 * A scope is a set of workspace-relative directory prefixes. It is a property of
 * the BINDING, never of the workspace: two machines may hold different scopes and
 * the server never learns either (paths are ciphertext, §2).
 */
import { isSafeRelPath } from "../../engine/index.js";

/** Every prefix a scoped binding may hold. Bounded so a hand-edited binding
 *  record cannot turn every path decision into a linear scan of user input. */
export const MAX_SCOPE_PREFIXES = 64;

export type ScopeValidation =
  | { ok: true; prefixes: string[] }
  | { ok: false; error: string };

/** Normalize one user-supplied prefix to the manifest's POSIX-relative form.
 *  Returns undefined when the input can never name a workspace subtree. */
export function normalizeScopePrefix(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  return isSafeRelPath(trimmed) ? trimmed : undefined;
}

/** `a` strictly contains `b` (`b` lives under `a`). Segment-aware: `foo` does not
 *  contain `foobar`. */
export const containsPrefix = (a: string, b: string): boolean => b.startsWith(`${a}/`);

/** Is `rel` inside (or equal to) `prefix`? */
export const withinPrefix = (prefix: string, rel: string): boolean =>
  rel === prefix || rel.startsWith(`${prefix}/`);

/**
 * The §3.1 bind-time table: normalized, deduplicated, non-nested, non-overlapping,
 * non-empty. Returns the sorted accepted set so the binding record and the registry
 * witness are byte-comparable.
 */
export function validateScopePrefixes(raw: readonly string[]): ScopeValidation {
  const normalized: string[] = [];
  for (const entry of raw) {
    const prefix = normalizeScopePrefix(entry);
    if (prefix === undefined) {
      return { ok: false, error: `'${entry.trim()}' is not a folder inside the workspace — use a path like Personal/repo-A` };
    }
    if (!normalized.includes(prefix)) normalized.push(prefix);
  }
  if (normalized.length === 0) return { ok: false, error: "name at least one folder to sync — an empty scope is not a binding" };
  if (normalized.length > MAX_SCOPE_PREFIXES) {
    return { ok: false, error: `that is more than ${MAX_SCOPE_PREFIXES} folders — sync the whole workspace instead` };
  }
  const sorted = [...normalized].sort();
  for (const a of sorted) {
    for (const b of sorted) {
      if (a !== b && containsPrefix(a, b)) {
        return { ok: false, error: `'${b}' is already inside '${a}' — list only the outer folder` };
      }
    }
  }
  return { ok: true, prefixes: sorted };
}

/**
 * Refuse a prefix that would split a git repository (§4 "sub-repo scopes"). A repo
 * key that STRICTLY CONTAINS a prefix means the prefix is a piece of that repo's
 * history; file-plane-only trees are unaffected because they have no repo key.
 */
export function scopeSplitsRepo(prefixes: readonly string[], repoKeys: Iterable<string>): { prefix: string; repo: string } | undefined {
  for (const repo of repoKeys) {
    const key = repo === "." ? "" : repo;
    if (key === "") continue;
    for (const prefix of prefixes) {
      if (containsPrefix(key, prefix)) return { prefix, repo: key };
    }
  }
  return undefined;
}

/** Parse the `--scope` flag: comma-separated, repeatable by comma only (the flag
 *  parser keeps one value per name). */
export const parseScopeFlag = (value: string): string[] =>
  value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
