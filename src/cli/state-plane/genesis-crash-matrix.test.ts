/**
 * G1–G6, design 222 §7.1 — the genesis crash matrix, driven by real crashes.
 *
 * `genesis.test.ts` owns the unit rows and builds its images by hand. This file
 * owes the other half: every state here is reached by driving the real
 * `establish()` to a real instant and ending the process there, so whatever is
 * on disk is what the machine actually leaves. Nothing is hand-planted except
 * the transitions named — with a comment — as unreachable from inside genesis,
 * and each of those still uses bytes a real crashed run produced.
 *
 * TWO RIG FINDINGS, recorded here because they shape everything below. Both
 * were fixed in this same PR; the history is kept because it explains the file.
 * 1. `migration/fault-rig.ts` originally patched only the `node:fs` DEFAULT
 *    EXPORT. Genesis performs 28 of its 36 workspace-touching calls through
 *    `node:fs/promises` — including the intent publication, BOTH renames and
 *    BOTH parent fsyncs, i.e. every kill point §7.2 names for genesis — so the
 *    rig could not reach a single one. The rig now takes a `surface`.
 *    `patchPromise` below is NOT that gap surviving: it remains because its
 *    predicates match on NON-STRING arguments (`typeof args[1] === "number"`,
 *    to catch one `open` overload and not another), which the rig's
 *    regex-over-joined-string-arguments deliberately cannot express. Where a
 *    path regex suffices, use the rig.
 * 2. `migration/fault-rig-child.ts` had a `genesis` command that minted
 *    `randomUUID()` ids while `installGenesisLineage` requires `^[0-9a-f]{32}$`,
 *    so it threw at step 4 on every invocation and could never reach steps 5–7.
 *    That command is now deleted rather than fixed: §7.9 forbids `migration/**`
 *    from importing `genesis.ts`, and a harness is not exempt from a structural
 *    rule it can silently break. The child below is genesis's own.
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkStateMigration } from "../doctor-state-plane.js";
import { saveConfig, type WorkspaceConfig } from "../workspace-config.js";
import { assertAuthorityWritable } from "./authority-bootstrap.js";
import { authorityMarkerBytes } from "./authority-marker.js";
import { StateAuthorityCorruptError, StateWriteRefusedError } from "./errors.js";
import { establish, readGenesisIntent, type GenesisIds } from "./genesis.js";
import { rboxResidue, rboxResiduePaths } from "./migration/fault-rig.js";
import { inodeOf as inodeKey, replaceUnderNewInode } from "./migration/inode-fixtures.js";
import { genesisPaths, sqliteResetPaths, statePath } from "./paths.js";
import { openStateStore, stateStoreDatabase } from "./store/open.js";

// The branded lock witness, constructed rather than acquired. This is §7.9's
// enumerated test exception to the cast gate, and the repo convention at ten
// other sites. It is sound HERE for one specific reason, not by habit:
// `establish` takes the bundle as proof-of-exclusivity and never reads a member
// of it, so a real bundle and this one are indistinguishable to the code under
// test. The migration child takes the trouble to acquire a real bundle because
// it drives a whole command that DOES pass locks onward.
const LOCKS = {} as Parameters<typeof establish>[2];
const SIDECARS = ["-wal", "-shm", "-journal"];
const hex32 = (): string => randomBytes(16).toString("hex");
const freshIds = (): GenesisIds => ({ authorityId: hex32(), lineageId: hex32() });

async function workspace(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-gcm-${process.pid}-${hex32()}-`));
  const config: WorkspaceConfig = {
    schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev",
    rootPath: root, remoteUrl: "https://example.invalid", token: "",
  };
  await saveConfig(root, config);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  return root;
}

/** The crash child. SIGKILL cannot be caught, so a kill point only means
 * something in a process the test does not need back. It plants nothing: it
 * runs the real `establish()` and dies between two of its own syscalls. A point
 * that never matches exits 65 — an unreachable kill point must read as a
 * failure, never as a silent pass. */
const CHILD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `rbox-gcm-child-${process.pid}-`));
const CHILD = path.join(CHILD_DIR, "genesis-crash-child.ts");
fs.writeFileSync(CHILD, `
import fs from "node:fs";
import { establish } from ${JSON.stringify(path.join(import.meta.dir, "genesis.ts"))};
const [root, authorityId, lineageId, specJson] = process.argv.slice(2);
const spec = JSON.parse(specJson);
const table = fs.promises;
const call = table[spec.syscall];
let matched = 0;
let fired = false;
table[spec.syscall] = function patched(...args) {
  const subject = args.filter((a) => typeof a === "string").join("\\u0000");
  if (spec.match !== undefined && !new RegExp(spec.match).test(subject)) return call.apply(this, args);
  matched += 1;
  if (matched !== (spec.nth ?? 1)) return call.apply(this, args);
  fired = true;
  if (spec.when === "before") process.kill(process.pid, "SIGKILL");
  return Promise.resolve(call.apply(this, args)).then((value) => {
    process.kill(process.pid, "SIGKILL");
    return value;
  });
};
try { await establish(root, () => ({ authorityId, lineageId }), {}); } catch (error) { console.error(String(error)); }
if (!fired) { console.error("fault point never matched: " + specJson); process.exit(65); }
process.exit(0);
`);

interface KillPoint { syscall: string; match?: string; nth?: number; when?: "before" | "after" }

function crash(root: string, ids: GenesisIds, point: KillPoint): void {
  const argv = [CHILD, root, ids.authorityId, ids.lineageId, JSON.stringify(point)];
  const child = spawnSync(process.execPath, argv, { encoding: "utf8" });
  if (child.status === 65) throw new Error(`unreachable kill point ${JSON.stringify(point)}: ${child.stderr}`);
  if (child.signal === "SIGKILL") return;
  throw new Error(`expected SIGKILL, got status=${child.status} signal=${child.signal}: ${child.stderr}`);
}

/** Derived from the ordered trace of a real uninterrupted `establish()`. */
const AFTER_STAGED_CLAIM: KillPoint = { syscall: "open", match: "state\\.db\\.genesis\\.", when: "after" };
const AFTER_INTENT_RENAME: KillPoint = { syscall: "rename", match: "genesis-v1\\.json$", when: "after" };
const BEFORE_STAGED_SEAL: KillPoint = { syscall: "open", match: "state\\.db\\.genesis\\.", nth: 2, when: "before" };
const AFTER_ACTIVE_RENAME: KillPoint = { syscall: "rename", match: "state\\.db$", when: "after" };
const AFTER_Q_RENAME: KillPoint = { syscall: "rename", match: "state\\.json$", when: "after" };
/** Step 7's evidence re-read, i.e. after step 6's sibling write AND its fsync. */
const BEFORE_STEP_7: KillPoint = { syscall: "realpath", nth: 2, when: "before" };

/** The in-process half of the same primitive, for errno injection on the
 * promise surface. `hit` inspects the raw arguments rather than a joined string
 * because two different calls open the same pathname with different flags. */
function patchPromise(name: string, hit: (args: unknown[]) => boolean, nth: number, act: () => never): () => void {
  const table = fs.promises as unknown as Record<string, unknown>;
  const call = table[name] as (...args: unknown[]) => unknown;
  let matched = 0;
  table[name] = function patched(this: unknown, ...args: unknown[]): unknown {
    if (!hit(args)) return call.apply(this, args);
    matched += 1;
    if (matched !== nth) return call.apply(this, args);
    return act();
  };
  return () => { table[name] = call; };
}

const errno = (c: string): never => { throw Object.assign(new Error(`${c}: injected`), { code: c }); };

/**
 * The whole `.rbox` tree, sidecars included (222 §7.1 r6), with two named
 * normalizations. FINDING: r6's "byte-identical whole tree" is not literally
 * satisfiable for genesis. `installGenesisLineage` stamps
 * `migration_completion.completed_at` with `new Date().toISOString()`
 * (`schema/application.ts:81`), so two runs of the same genesis never produce
 * the same `state.db` bytes. Every other file — `Q` included — is compared
 * byte-for-byte, and `state.db` is compared on the exact §2.5.1 tuple instead.
 * `workspace.json` is genesis's INPUT and embeds the workspace's own path, so
 * it is compared by presence.
 */
function residueShape(root: string): Record<string, string> {
  const residue = rboxResidue(root);
  const active = sqliteResetPaths.active(root);
  const key = path.relative(path.join(root, ".rbox"), active);
  if (residue["workspace.json"]) residue["workspace.json"] = "<workspace config>";
  if (residue[key]) residue[key] = storeTuple(active);
  return residue;
}

/** Read-only, and it removes exactly the sidecars its own open created. */
function storeTuple(file: string): string {
  const before = SIDECARS.filter((suffix) => fs.existsSync(`${file}${suffix}`));
  const store = openStateStore(file, { readonly: true });
  try {
    const row = stateStoreDatabase(store).query(
      "SELECT origin_kind,migration_id,entry_count,repo_count FROM migration_completion WHERE singleton=1",
    ).get() as Record<string, unknown>;
    return JSON.stringify([store.header.authority_id, store.header.active_lineage_id, row]);
  } finally {
    store.close();
    for (const s of SIDECARS) if (!before.includes(s)) fs.rmSync(`${file}${s}`, { force: true });
  }
}

/** An uninterrupted genesis under the same ids — the thing every resumed run
 * must land on. */
async function uninterrupted(ids: GenesisIds): Promise<Record<string, string>> {
  const root = await workspace();
  expect(await establish(root, () => ids, LOCKS)).toEqual({ kind: "established", authorityId: ids.authorityId });
  return residueShape(root);
}

test("G1: a full genesis publishes Q, retires the intent, and leaves no migration artifact", async () => {
  const root = await workspace();
  const ids = freshIds();
  expect(await establish(root, () => ids, LOCKS)).toEqual({ kind: "established", authorityId: ids.authorityId });

  const paths = rboxResiduePaths(root);
  expect(paths).toEqual(["state.json", "state/state.db", "workspace.json"]);
  expect(fs.readFileSync(statePath(root))).toEqual(authorityMarkerBytes(ids.authorityId));
  expect(readGenesisIntent(root)).toBeUndefined();
  // The namespace inventory: not "no known artifact", but nothing anywhere in
  // any migration namespace, so a future artifact name cannot slip past.
  const migrationNamespaces = [
    "migration-v1.json", "migration-emergency.", "reset-v1.json", "reset-candidates/",
    "lineages/", "legacy-json/", "reserve-1mib.bin", "quarantine/", ".migrate.",
  ];
  for (const namespace of migrationNamespaces) {
    expect(paths.filter((p) => p.includes(namespace)), namespace).toEqual([]);
  }
  expect(storeTuple(sqliteResetPaths.active(root))).toBe(JSON.stringify([
    ids.authorityId, ids.lineageId,
    { origin_kind: "genesis", migration_id: `genesis:${ids.lineageId}`, entry_count: 0, repo_count: 0 },
  ]));
});

test("G2 case 2: killed after the active rename, the resume lands on the uninterrupted tree", async () => {
  const root = await workspace();
  const ids = freshIds();
  crash(root, ids, AFTER_ACTIVE_RENAME);

  expect(fs.existsSync(statePath(root))).toBe(false);
  expect(fs.existsSync(sqliteResetPaths.active(root))).toBe(true);
  expect(readGenesisIntent(root)?.authorityId).toBe(ids.authorityId);

  expect(await establish(root, () => ids, LOCKS)).toEqual({ kind: "established", authorityId: ids.authorityId });
  expect(residueShape(root)).toEqual(await uninterrupted(ids));
  // The comparison has teeth: a different authority id is a different tree.
  expect(residueShape(root)).not.toEqual(await uninterrupted(freshIds()));
}, 30_000);

test("G2 case 3-clean: killed before the staged seal, the resume lands on the uninterrupted tree", async () => {
  const root = await workspace();
  const ids = freshIds();
  crash(root, ids, BEFORE_STAGED_SEAL);

  const staged = genesisPaths.staged(root, ids.authorityId);
  expect(fs.existsSync(sqliteResetPaths.active(root))).toBe(false);
  expect(fs.statSync(staged).size).toBeGreaterThan(0);

  expect(await establish(root, () => ids, LOCKS)).toEqual({ kind: "established", authorityId: ids.authorityId });
  expect(residueShape(root)).toEqual(await uninterrupted(ids));
}, 30_000);

test("G2 case 3-unopenable: the recorded inode survives the repair, and unlinking it halts", async () => {
  const root = await workspace();
  const ids = freshIds();
  crash(root, ids, AFTER_INTENT_RENAME);

  const staged = genesisPaths.staged(root, ids.authorityId);
  expect(fs.statSync(staged).size).toBe(0); // the intent is durable, the database is not
  const recorded = inodeKey(staged);

  expect(await establish(root, () => ids, LOCKS)).toEqual({ kind: "established", authorityId: ids.authorityId });
  // C3: `ftruncate` in place, never unlink — the active path holds the RECORDED
  // inode, so a second kill reads case 3 again and never case 6.
  expect(inodeKey(sqliteResetPaths.active(root))).toBe(recorded);
  expect(residueShape(root)).toEqual(await uninterrupted(ids));

  // Negative control: r3's remedy. Unlink the recorded inode, let the rebuild
  // recreate the staged path, and the identical workspace that just succeeded
  // now halts. `replaceUnderNewInode` because unlink+recreate can recycle.
  const control = await workspace();
  const controlIds = freshIds();
  crash(control, controlIds, AFTER_INTENT_RENAME);
  const controlStaged = genesisPaths.staged(control, controlIds.authorityId);
  const controlRecorded = inodeKey(controlStaged);
  expect(replaceUnderNewInode(controlStaged, "", { mode: 0o600 })).not.toBe(controlRecorded);
  await expect(establish(control, () => controlIds, LOCKS)).rejects.toThrow(StateAuthorityCorruptError);
}, 40_000);

test("G2 case 4: nothing durable followed the intent — rebuild under a fresh authority id", async () => {
  const root = await workspace();
  const dead = freshIds();
  crash(root, dead, AFTER_INTENT_RENAME);

  // The ONE hand-made transition in this file, and only because no SIGKILL can
  // produce it. FINDING against §7.1's G2 row ("SIGKILL at each of §2.5.2's
  // cases 2, 3-clean, 3-unopenable, and 4"): step 2 creates the staged file and
  // fsyncs its parent BEFORE step 3 publishes the intent, so on an ordered
  // filesystem an intent never survives without its staged file. Case 4's real
  // producers are outside genesis — a reaper of `.rbox/state`, a partial
  // restore, or a crash-consistency reordering. Every byte here is still the
  // crashed child's; only the staged file's removal is this test's.
  fs.unlinkSync(genesisPaths.staged(root, dead.authorityId));

  const reborn = freshIds();
  expect(await establish(root, () => reborn, LOCKS)).toEqual({ kind: "established", authorityId: reborn.authorityId });
  expect(fs.readFileSync(statePath(root))).toEqual(authorityMarkerBytes(reborn.authorityId));
  expect(residueShape(root)).toEqual(await uninterrupted(reborn));
}, 30_000);

test("G3: an L published between step 6's fsync and step 7's rename refuses and renames nothing", async () => {
  const root = await workspace();
  const ids = freshIds();
  const legacy = '{"lastSyncedSequence":7}';
  const outcome = await establish(root, () => ids, LOCKS, {
    afterQPrepared: async () => { await fsp.writeFile(statePath(root), legacy); },
  });

  expect(outcome).toEqual({ kind: "refused", reason: "legacy-present" });
  expect(fs.readFileSync(statePath(root), "utf8")).toBe(legacy); // L byte-identical
  expect(readGenesisIntent(root)).toBeUndefined();
  // Own artifacts removed, and the whole tree — sidecars included — is back to
  // the pre-genesis workspace.
  expect(rboxResiduePaths(root)).toEqual(["state.json", "workspace.json"]);

  // Negative control: r3's ordering, where the legacy check ran before step 6
  // and saw an absent path. An injected ENOENT at step 7's `classifyStateFormat`
  // open is exactly that observation, and the same fixture then overwrites L.
  const control = await workspace();
  const controlIds = freshIds();
  const restore = patchPromise(
    "open", (args) => args[0] === statePath(control) && typeof args[1] === "number", 2, () => errno("ENOENT"),
  );
  try {
    expect(await establish(control, () => controlIds, LOCKS, {
      afterQPrepared: async () => { await fsp.writeFile(statePath(control), legacy); },
    })).toEqual({ kind: "established", authorityId: controlIds.authorityId });
  } finally {
    restore();
  }
  expect(fs.readFileSync(statePath(control))).toEqual(authorityMarkerBytes(controlIds.authorityId));
});

test("G4: killed after the authority rename, the write fence refuses until recovery retires the intent", async () => {
  const root = await workspace();
  const ids = freshIds();
  crash(root, ids, AFTER_Q_RENAME);

  // §2.5.2 case 1: Q is published and the intent survives, so the `.rbox` fsync
  // may not have completed.
  expect(fs.readFileSync(statePath(root))).toEqual(authorityMarkerBytes(ids.authorityId));
  expect(readGenesisIntent(root)?.authorityId).toBe(ids.authorityId);

  let refusal: unknown;
  try { assertAuthorityWritable(root); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(StateWriteRefusedError);
  expect((refusal as StateWriteRefusedError).reason).toBe("authority-recovery-pending");

  expect(await establish(root, () => ids, LOCKS)).toEqual({ kind: "already-established" });
  expect(readGenesisIntent(root)).toBeUndefined();
  expect(() => assertAuthorityWritable(root)).not.toThrow(); // writes then flow
  expect(residueShape(root)).toEqual(await uninterrupted(ids));

  // Negative control: the fence's condition is the surviving intent and nothing
  // else. Remove it from an identically crashed workspace and the write lands
  // while recovery has demonstrably not run.
  const control = await workspace();
  const controlIds = freshIds();
  crash(control, controlIds, AFTER_Q_RENAME);
  fs.unlinkSync(genesisPaths.intent(control));
  expect(() => assertAuthorityWritable(control)).not.toThrow();
}, 40_000);

test("G5: a complete genesis database copied from another workspace never publishes Q", async () => {
  const donor = await workspace();
  const donorIds = freshIds();
  await establish(donor, () => donorIds, LOCKS);

  const root = await workspace();
  fs.copyFileSync(sqliteResetPaths.active(donor), sqliteResetPaths.active(root));
  const before = rboxResidue(root);

  // G5 asserts a REFUSAL (222 §7.1) — the machine's answer to the copy, not
  // silence; F5/F6 are the rows that assert silence.
  expect(await establish(root, () => freshIds(), LOCKS)).toEqual({ kind: "refused", reason: "artifact-present" });
  expect(rboxResidue(root)).toEqual(before); // zero writes
  expect(fs.existsSync(statePath(root))).toBe(false); // no Q published

  // Negative control: under r3's withdrawn `origin_kind`-keyed rule this exact
  // file satisfies the predicate, so the copy's authority id would have been
  // published as this workspace's Q.
  expect(storeTuple(sqliteResetPaths.active(root))).toBe(JSON.stringify([
    donorIds.authorityId, donorIds.lineageId,
    { origin_kind: "genesis", migration_id: `genesis:${donorIds.lineageId}`, entry_count: 0, repo_count: 0 },
  ]));
  expect(rboxResidue(root)).toEqual(before);
}, 30_000);

test("G6: foreign-id strands and a foreign-evidence intent are never adopted and never deleted", async () => {
  // (a) A zero-byte staged file scoped to a dead authority id, produced by a
  // real kill between step 2's claim and step 3's publication.
  const root = await workspace();
  const dead = freshIds();
  crash(root, dead, AFTER_STAGED_CLAIM);
  const strand = genesisPaths.staged(root, dead.authorityId);
  expect(fs.statSync(strand).size).toBe(0);
  expect(readGenesisIntent(root)).toBeUndefined(); // nothing names it

  const live = freshIds();
  expect(await establish(root, () => live, LOCKS)).toEqual({ kind: "established", authorityId: live.authorityId });
  expect(fs.existsSync(strand)).toBe(true); // U3 grants no deletion authority
  expect(fs.statSync(strand).size).toBe(0);
  // FINDING against §7.1's G6 row ("reported by doctor as an inert artifact"):
  // `doctor-state-plane.ts` reads only the control and the intent and never
  // classifies artifacts, so an inert strand is invisible. Asserted as it is.
  expect(checkStateMigration(root)).toMatchObject({ ok: true, message: "no conversion in progress" });

  // (b) A well-formed Q sibling scoped to a different authority id. Produced by
  // a real kill after step 6's sibling fsync in a donor workspace, then carried
  // in on a copied `.rbox` — §2.5.2 case 7's own producer. Every byte is the
  // donor machine's.
  const donor = await workspace();
  const donorIds = freshIds();
  crash(donor, donorIds, BEFORE_STEP_7);
  const donorSibling = genesisPaths.qSibling(donor, donorIds.authorityId);
  expect(fs.readFileSync(donorSibling)).toEqual(authorityMarkerBytes(donorIds.authorityId));

  const carried = await workspace();
  const foreignSibling = genesisPaths.qSibling(carried, donorIds.authorityId);
  fs.copyFileSync(donorSibling, foreignSibling);
  const carriedIds = freshIds();
  expect(await establish(carried, () => carriedIds, LOCKS))
    .toEqual({ kind: "established", authorityId: carriedIds.authorityId });
  expect(fs.readFileSync(foreignSibling)).toEqual(authorityMarkerBytes(donorIds.authorityId));
  expect(fs.readFileSync(statePath(carried))).toEqual(authorityMarkerBytes(carriedIds.authorityId));

  // (c) Case 7: a well-formed intent whose bound evidence is another
  // workspace's, carried in the same way.
  const copied = await workspace();
  fs.copyFileSync(genesisPaths.intent(donor), genesisPaths.intent(copied));
  fs.copyFileSync(sqliteResetPaths.active(donor), sqliteResetPaths.active(copied));
  const untouched = rboxResidue(copied);
  await expect(establish(copied, () => freshIds(), LOCKS)).rejects.toThrow(StateAuthorityCorruptError);
  expect(rboxResidue(copied)).toEqual(untouched); // zero writes, nothing deleted
  expect(fs.existsSync(statePath(copied))).toBe(false);
  expect(checkStateMigration(copied)).toMatchObject({ ok: false, status: "state-genesis/unfinished" });
}, 40_000);

test("ENOSPC at the intent write leaves an unowned zero-byte staged file and nothing else", async () => {
  const root = await workspace();
  const ids = freshIds();
  const restore = patchPromise(
    "open",
    (args) => typeof args[0] === "string" && args[0].endsWith("genesis-v1.json") && args[1] === "w",
    1,
    () => errno("ENOSPC"),
  );
  try {
    await expect(establish(root, () => ids, LOCKS)).rejects.toThrow(/ENOSPC/);
  } finally {
    restore();
  }

  const staged = `state/${path.basename(genesisPaths.staged(root, ids.authorityId))}`;
  expect(rboxResiduePaths(root)).toEqual([staged, "workspace.json"]);
  expect(fs.statSync(path.join(root, ".rbox", staged)).size).toBe(0);
  expect(readGenesisIntent(root)).toBeUndefined();
  expect(fs.existsSync(statePath(root))).toBe(false);
});

test("every crash between the staged claim and the intent leaks one zero-byte strand, forever", async () => {
  const root = await workspace();
  const crashes = 5;
  for (let i = 0; i < crashes; i += 1) crash(root, freshIds(), AFTER_STAGED_CLAIM);

  const strands = rboxResiduePaths(root).filter((p) => p.includes("state.db.genesis."));
  expect(strands).toHaveLength(crashes); // one per crash: re-entry mints a new id
  const stats = strands.map((p) => fs.statSync(path.join(root, ".rbox", p)));
  // MEASURED, against the open item's "~1 KB per crash": each strand is a
  // zero-byte file with zero allocated blocks. The cost is one directory entry
  // and one inode, not a kilobyte of content.
  expect(stats.map((s) => s.size)).toEqual(Array.from({ length: crashes }, () => 0));
  expect(stats.map((s) => s.blocks)).toEqual(Array.from({ length: crashes }, () => 0));

  // And a healthy genesis still completes over them, adopting none of them.
  const live = freshIds();
  expect(await establish(root, () => live, LOCKS)).toEqual({ kind: "established", authorityId: live.authorityId });
  expect(rboxResiduePaths(root).filter((p) => p.includes("state.db.genesis."))).toHaveLength(crashes);
}, 40_000);
