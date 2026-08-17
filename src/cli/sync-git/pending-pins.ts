/**
 * Design 273 P3 — keeping the OTHER computer's paused work readable.
 *
 * When rbox pauses a repo it has already imported the incoming objects, but
 * nothing references them: `cleanupRefs` drops the staging namespace and the
 * commits become unreachable, so every later surface that wants to say "4
 * commits newer, most recent 'fix stripe webhook retry'" has to re-fetch from
 * the network. Pinning the incoming tips under `refs/rbox-pending/` makes that
 * evidence a local read, forever fresh, with no cache and no schema change.
 *
 * Two properties this namespace is chosen for, both verified by test:
 * - `isSyncableRef` admits only heads/tags/stash, so a pin never enters a
 *   capture, a quarantine bundle, or the design-270 held-skip fingerprint
 *   (loose-ref AND packed-refs paths both filter through it). A user running
 *   `git pack-refs` cannot make a pin visible.
 * - the pins are LIFETIME-scoped, not age-scoped. `pruneStaleScratchRefs`'
 *   one-hour cutoff would delete the evidence for exactly the population that
 *   needs it (holds standing for days), so pins have their own authority below.
 *
 * ONE authority owns deletion: {@link reconcilePendingPins}, run once per repo
 * per pull. It deletes every pin whose key is not the repo's current incoming
 * key, which subsumes hold-clear, resolve, key-change, and every crash or reset
 * orphan (a crash between the pin write and the record write leaves a pin the
 * record never names, and the next pull collects it) without any of those
 * events needing to know pins exist.
 *
 * Cost, named trade: the pinned pack objects are retained for the hold's
 * lifetime. Nothing else is retained — a pin is one 41-byte loose ref.
 *
 * The one case with no collector: a repo that leaves rbox's scope entirely —
 * `syncGit` turned off, the repo removed from the workspace, the binding
 * rescoped — is never visited by a pull again, so its pins stand until the repo
 * is deleted or a later pull brings it back and sweeps it. That is bounded
 * retained disk in a repository rbox no longer manages, never a correctness
 * effect, and it is the deliberate price of a convergent sweep with no event
 * subscriptions.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { GitSection } from "../../engine/types.js";
import { git, gitStatus } from "../../engine/git-spawn.js";
import { hashBytes } from "../../engine/hash.js";
import { HEX40 } from "./git-state.js";
import type { OwnedRefMutationBoundary } from "./pins.js";

export const PENDING_NS = "refs/rbox-pending";

/**
 * Linked worktrees SHARE one ref store, so `refs/rbox-pending/<key>` alone is
 * not a per-repo name: a sibling worktree's reconciliation would collect this
 * repo's live pin because the key is not ITS current key. The relative path is
 * folded into the namespace for the same reason capture pins are
 * capture-unique. 12 hex is ample for names that only ever have to differ from
 * their own siblings.
 */
export const pendingPinScope = (relPath: string): string => hashBytes(Buffer.from(relPath)).slice(0, 12);

const scopeNs = (relPath: string): string => `${PENDING_NS}/${pendingPinScope(relPath)}`;

/** Every commit the paused incoming section names, deduplicated. Detached heads
 * carry their tip in `head` rather than in `refs`, so both are read. */
export function pendingPinOids(incoming: GitSection): string[] {
  const oids = new Set<string>();
  for (const oid of Object.values(incoming.refs)) if (HEX40.test(oid)) oids.add(oid);
  const head = incoming.head.trim();
  if (HEX40.test(head)) oids.add(head);
  return [...oids].sort();
}

/** Objects the import actually landed. A section can name an oid this receiver
 * never got (a partial or refused fetch); pinning it would fail the whole
 * update-ref transaction and cost the repo every OTHER pin it could have kept. */
async function presentOids(repoDir: string, oids: string[]): Promise<string[]> {
  if (oids.length === 0) return [];
  const result = await gitStatus(repoDir, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    stdin: oids.join("\n") + "\n",
  });
  if (result.status !== "ok") return [];
  const present = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const [oid, type] = line.trim().split(" ");
    if (oid && type === "commit") present.add(oid);
  }
  return oids.filter((oid) => present.has(oid));
}

/**
 * Every ref mutation in this module goes through the SAME daemon observation
 * lease `pins.ts` uses. Deleting a pin that a user's `git pack-refs` folded into
 * `packed-refs` rewrites that file under `packed-refs.lock`, and an unleased
 * rewrite is attributed to the user — waking the ref watcher and charging rbox's
 * own bookkeeping to the person it is meant to be invisible to.
 */
async function updateRefBatch(
  repoDir: string,
  commands: string[],
  boundary?: OwnedRefMutationBoundary,
): Promise<void> {
  if (commands.length === 0) return;
  const lease = await boundary?.enterOwnedRefMutation(repoDir).catch(() => undefined);
  try {
    await git(repoDir, ["update-ref", "--stdin"], { stdin: commands.join("\n") + "\n" }).catch(() => {});
  } finally {
    await lease?.finish().catch(() => {});
  }
}

/**
 * Pin the paused incoming tips. Best-effort by contract: a repo that cannot be
 * pinned degrades to tier-2 evidence (branch + date from the record), never to
 * a failed pull — this is a legibility aid, not a durability mechanism.
 */
export async function writePendingPins(
  repoDir: string,
  relPath: string,
  incomingKey: string,
  incoming: GitSection,
  boundary?: OwnedRefMutationBoundary,
): Promise<void> {
  const present = await presentOids(repoDir, pendingPinOids(incoming));
  await updateRefBatch(
    repoDir,
    present.map((oid, index) => `create ${scopeNs(relPath)}/${incomingKey}/${index} ${oid}`),
    boundary,
  );
}

/**
 * Pin keys currently present for this repo, read WITHOUT spawning git: the sweep
 * runs for every repo on every pull, and a `for-each-ref` per repo per pull is
 * real time against the ≤10s propagation target.
 *
 * Both storage forms are read unconditionally, and that is a MEASURED choice
 * rather than a concession: `git pack-refs --all` prunes the scoped directories,
 * so a loose-directory gate would have hidden every packed pin from its own
 * collector. The steady-state cost is one ENOENT-tolerant `readdir` plus one
 * small sequential read — 11 microseconds per repo on this fleet's hardware,
 * about a millisecond per pull across the 103-repo host, against a ≤10s
 * propagation target.
 */
async function pinnedKeys(gitCommonDir: string, relPath: string): Promise<Set<string>> {
  const ns = scopeNs(relPath);
  const keys = new Set(await fs.readdir(path.join(gitCommonDir, ns)).catch(() => [] as string[]));
  const packed = await fs.readFile(path.join(gitCommonDir, "packed-refs"), "utf8").catch(() => "");
  for (const line of packed.split("\n")) {
    const ref = line.slice(line.indexOf(" ") + 1);
    if (!ref.startsWith(`${ns}/`)) continue;
    const key = ref.slice(ns.length + 1).split("/")[0];
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * THE pin lifecycle authority (design 273 P3). Deletes every pin whose key is
 * not `currentKey`; pass `undefined` when the repo holds nothing, which
 * collects all of them.
 *
 * Deliberately reads the record's key rather than subscribing to hold-clear,
 * resolve, key-change, removal and crash events: one convergent sweep cannot
 * miss an event it was never told about.
 */
export async function reconcilePendingPins(
  repoDir: string,
  gitCommonDir: string,
  relPath: string,
  currentKey: string | undefined,
  boundary?: OwnedRefMutationBoundary,
): Promise<void> {
  const keys = await pinnedKeys(gitCommonDir, relPath);
  const orphans = [...keys].filter((key) => key !== currentKey);
  if (orphans.length === 0) return;
  const ns = scopeNs(relPath);
  const refs = await git(repoDir, ["for-each-ref", "--format=%(refname)", ...orphans.map((key) => `${ns}/${key}`)])
    .catch(() => "");
  await updateRefBatch(repoDir, refs.split("\n").filter(Boolean).map((ref) => `delete ${ref}`), boundary);
}

/** The pinned tips for one paused repo, in no particular order. Empty when
 * nothing is pinned — the caller degrades a tier rather than failing. */
export async function readPendingPins(repoDir: string, relPath: string, incomingKey: string): Promise<string[]> {
  const out = await git(repoDir, [
    "--no-optional-locks", "for-each-ref", "--format=%(objectname)", `${scopeNs(relPath)}/${incomingKey}`,
  ]).catch(() => "");
  return [...new Set(out.split("\n").map((line) => line.trim()).filter((oid) => HEX40.test(oid)))];
}
