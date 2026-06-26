import path from "node:path";
import { sameContent } from "./diff.js";
import { indexByPath } from "./diff.js";
import type { FileEntry, Manifest } from "./types.js";

/**
 * A single change to apply to the local working tree to bring it in line with
 * the remote, decided by a three-way comparison (base = last-synced).
 */
export type Action =
  | { kind: "write"; entry: FileEntry }
  | { kind: "delete"; path: string }
  | {
      /** Both sides edited the same path differently — keep both, lose nothing. */
      kind: "conflict";
      path: string;
      /** Where the current local copy is moved before the remote is written. */
      keepLocalAs: string;
      entry: FileEntry;
    };

/**
 * Three-way reconcile of `local` against `remote`, using `base` (the manifest
 * both sides last agreed on) to tell "they changed it" from "I changed it".
 *
 * Per path:
 * - local already equals remote        → nothing
 * - local untouched since base         → take remote (write, or delete if remote dropped it)
 * - remote untouched since base        → local is ahead; no local change (it'll be pushed)
 * - both diverged and differ           → conflict: keep local aside, take remote
 *   - local deleted, remote modified   → restore remote (write)
 *   - remote deleted, local modified   → keep local (no local change)
 */
export function reconcile(
  base: Manifest,
  local: Manifest,
  remote: Manifest,
  device: string,
  now: string
): Action[] {
  const B = indexByPath(base);
  const L = indexByPath(local);
  const R = indexByPath(remote);

  const actions: Action[] = [];
  for (const p of new Set<string>([...B.keys(), ...L.keys(), ...R.keys()])) {
    const b = B.get(p);
    const l = L.get(p);
    const r = R.get(p);

    if (sameContent(l, r)) continue;

    if (sameContent(l, b)) {
      if (r) actions.push({ kind: "write", entry: r });
      else actions.push({ kind: "delete", path: p });
      continue;
    }

    if (sameContent(r, b)) continue; // local ahead; pushed elsewhere

    // Both sides diverged from base.
    if (r && l) {
      actions.push({ kind: "conflict", path: p, keepLocalAs: conflictName(p, device, now), entry: r });
    } else if (r && !l) {
      actions.push({ kind: "write", entry: r }); // delete-vs-modify → remote wins, nothing to keep
    }
    // (!r && l): remote deleted, local modified → keep local, no local action.
  }
  return actions;
}

/** `dir/index.ts` → `dir/index.<device>.<YYYYMMDDHHMMSS>.conflict.ts` */
export function conflictName(p: string, device: string, nowIso: string): string {
  const ext = path.posix.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  const ts = nowIso.replace(/[-:T]/g, "").slice(0, 14);
  return `${stem}.${device}.${ts}.conflict${ext}`;
}
