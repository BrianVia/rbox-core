import { sanitizeGitSectionForPersistence } from "./sync-git/config-sync.js";
import type { RepoRecordInput } from "./sync-state-model.js";

/**
 * The persistence invariant for a repository record's Git sections: BASE and
 * pending are stored in their sanitized form on EVERY write path — the apply
 * path, a carried record no packet named, a CAS recompute, and the legacy JSON
 * projection alike. One owner, so a new write path cannot quietly skip it.
 *
 * A record that already holds is returned unchanged, so callers may keep using
 * identity to detect that nothing needed rewriting.
 */
export function sanitizeRepoRecord<Stored extends RepoRecordInput>(record: Stored): Stored {
  const base = record.base === undefined ? undefined : sanitizeGitSectionForPersistence(record.base);
  const pending = record.pending === undefined ? undefined : sanitizeGitSectionForPersistence(record.pending);
  if (base === record.base && pending === record.pending) return record;
  const sanitized: Stored = { ...record };
  if (base !== undefined) sanitized.base = base;
  if (pending !== undefined) sanitized.pending = pending;
  return sanitized;
}
