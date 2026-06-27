/**
 * Shared, dependency-free manifest validation — imported by BOTH the control
 * plane (Worker/DO, before a commit advances the sequence) and the client
 * (before apply touches the filesystem). Never trust a manifest off the wire:
 * a malicious or corrupt one with `../`, an absolute path, or a NUL byte could
 * otherwise escape the workspace root (`path.join(root, entry.path)`).
 *
 * Pure string logic only (no node:*), so it bundles cleanly into the Worker.
 */

export const MAX_PATH_BYTES = 1024;
export const MAX_ENTRIES = 200_000; // monorepo headroom; plan-tied caps come in M7b
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024; // hard ceiling on serialized manifest
export const MAX_SYMLINK_TARGET_BYTES = 4096;

const SHA_RE = /^[0-9a-f]{64}$/;
const utf8 = new TextEncoder();

/** A relative POSIX path that cannot escape the root or smuggle control bytes. */
export function isSafeRelPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0) return false;
  if (utf8.encode(p).length > MAX_PATH_BYTES) return false;
  if (p.includes("\0") || p.includes("\\")) return false; // NUL, backslash (Windows-style / smuggling)
  if (p.startsWith("/")) return false; // absolute
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false; // empty (//, leading/trailing /), . , ..
  }
  return true;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Validate a parsed manifest object. Returns the first problem found, or ok.
 * Enforces: safe relative paths, no duplicate paths (incl. case-insensitive,
 * for APFS/NTFS collisions), known types, well-formed shas/modes, bounded size.
 */
export function validateManifest(m: unknown): ValidationResult {
  if (m == null || typeof m !== "object") return { ok: false, error: "manifest is not an object" };
  const files: unknown = (m as { files?: unknown }).files;
  if (!Array.isArray(files)) return { ok: false, error: "manifest.files is not an array" };
  if (files.length > MAX_ENTRIES) return { ok: false, error: `too many entries (${files.length} > ${MAX_ENTRIES})` };

  const seen = new Set<string>();
  const seenLower = new Set<string>();

  for (const entry of files) {
    if (entry == null || typeof entry !== "object") return { ok: false, error: "entry is not an object" };
    const e = entry as Record<string, unknown>;

    if (!isSafeRelPath(e.path)) return { ok: false, error: `unsafe path: ${JSON.stringify(e.path)}` };
    const p = e.path as string;

    if (seen.has(p)) return { ok: false, error: `duplicate path: ${p}` };
    const lower = p.toLowerCase();
    if (seenLower.has(lower)) return { ok: false, error: `case-insensitive duplicate path: ${p}` };
    seen.add(p);
    seenLower.add(lower);

    if (e.type !== "file" && e.type !== "symlink") return { ok: false, error: `bad type for ${p}: ${JSON.stringify(e.type)}` };
    if (typeof e.sha256 !== "string" || !SHA_RE.test(e.sha256)) return { ok: false, error: `bad sha256 for ${p}` };
    if (e.encSha !== undefined && (typeof e.encSha !== "string" || !SHA_RE.test(e.encSha))) return { ok: false, error: `bad encSha for ${p}` };
    if (typeof e.size !== "number" || !Number.isInteger(e.size) || e.size < 0) return { ok: false, error: `bad size for ${p}` };
    if (typeof e.mode !== "number" || !Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o7777) return { ok: false, error: `bad mode for ${p}` };

    if (e.type === "symlink") {
      const t = e.symlinkTarget;
      if (typeof t !== "string" || t.length === 0) return { ok: false, error: `symlink ${p} missing target` };
      if (t.includes("\0")) return { ok: false, error: `symlink ${p} target has NUL` };
      if (utf8.encode(t).length > MAX_SYMLINK_TARGET_BYTES) return { ok: false, error: `symlink ${p} target too long` };
      // Note: the target STRING may point anywhere (legitimate symlinks do). Writing a symlink
      // does not write *through* it; the real defense against a symlink+file traversal combo is
      // the apply-time realpath-within-root guard (see apply.ts), not target validation here.
    }
  }
  return { ok: true };
}
