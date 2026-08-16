import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatLockMarker, publishLockMarker, serializeMarkerObservation, type ProcessIncarnation } from "../../engine/lockfile.js";
import { loadStateCasJournals } from "./state-cas-journal-loader.js";
import { parseStateCasJournal, parseV1 } from "./state-cas-journal.js";
import {
  acquirePreparedStateCasLocks,
  markStateCasCommitted,
  prepareStateCasLocks,
  recoverStateCasLocks,
  stateCasJournalDir,
} from "./state-cas-locks.js";

const OWNER: ProcessIncarnation = { hostId: "a".repeat(32), bootId: "b".repeat(32), pid: 41, startTime: "1" };
const identity = (status: "alive" | "dead") => ({
  current: async () => OWNER,
  probe: async () => status === "alive"
    ? { status: "alive" as const, startTime: OWNER.startTime }
    : { status: "dead" as const },
});
let root = "";

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-state-cas-journal-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function bareCommon(): Promise<string> {
  const common = path.join(root, "common.git");
  const child = Bun.spawn(["git", "init", "--bare", common], { stdout: "ignore", stderr: "pipe" });
  if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());
  return common;
}

async function fixture(count = 1) {
  const common = await bareCommon();
  const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, Array.from({ length: count }, (_, index) => ({
    commonDir: common,
    lockPath: path.join(common, "refs", "heads", `ref-${index}.lock`),
    proofs: [{ repo: ".", ref: `refs/heads/ref-${index}`, expectedOid: null }],
  })), { identity: identity("alive") });
  return { common, prepared: prepared! };
}

test("v2 header, acquisitions, locked, and committed fold across restart", async () => {
  const { prepared } = await fixture(2);
  expect(parseStateCasJournal(await fs.readFile(prepared.journalPath, "utf8"), prepared.journalPath)?.phase).toBe("prepared");
  await acquirePreparedStateCasLocks(prepared);
  expect(parseStateCasJournal(await fs.readFile(prepared.journalPath, "utf8"), prepared.journalPath)).toMatchObject({ version: 2, phase: "locked" });
  await markStateCasCommitted(prepared);
  const parsed = parseStateCasJournal(await fs.readFile(prepared.journalPath, "utf8"), prepared.journalPath);
  expect(parsed).toMatchObject({ version: 2, phase: "committed" });
  expect(parsed?.commonDirs[0]?.locks.every((lock) => lock.acquisition === "acquired")).toBe(true);
});

test("2000 realistic long refs acquire and fold with more than 2x byte headroom", async () => {
  const common = await bareCommon();
  const count = 2000;
  const prepared = await prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, Array.from({ length: count }, (_, index) => {
    const ref = `refs/remotes/origin/feature/team/cas-amortization-${String(index).padStart(4, "0")}`;
    return {
      commonDir: common,
      lockPath: path.join(common, `${ref}.lock`),
      proofs: [{ repo: `repositories/product-${String(index).padStart(4, "0")}`, ref, expectedOid: null }],
    };
  }), { identity: identity("alive") });
  const acquired = await acquirePreparedStateCasLocks(prepared!);
  const raw = await fs.readFile(prepared!.journalPath, "utf8");
  expect(Buffer.byteLength(raw)).toBeLessThan(8 * 1024 * 1024);
  expect(parseStateCasJournal(raw, prepared!.journalPath)?.commonDirs[0]?.locks.filter((lock) => lock.acquisition === "acquired")).toHaveLength(count);
  expect(acquired.acquired).toBe(count);
  // MAJOR-1 (final review): every FM-scale journal exceeds the 1 MiB v1 bound,
  // so the loader's v2 admission gate is the only path recovery has to it —
  // assert it BEFORE release (a clean release retires the journal).
  const loaded = await loadStateCasJournals(root);
  expect(loaded.length).toBe(1);
  expect(loaded[0]?.journal?.version).toBe(2);
  await acquired.release();
}, 30_000);

test("prepare refuses more than 4096 locks before publishing a journal", async () => {
  const common = path.join(root, "not-created.git");
  const requests = Array.from({ length: 4097 }, (_, index) => ({
    commonDir: common,
    lockPath: path.join(common, "refs", "heads", `${index}.lock`),
    proofs: [],
  }));
  await expect(prepareStateCasLocks(root, { stream: "stream", stateNonce: "1".repeat(32) }, requests, {
    identity: identity("alive"),
  })).rejects.toThrow("state-CAS lock count 4097 exceeds the v2 journal limit of 4096");
  expect(await fs.lstat(stateCasJournalDir(root)).then(() => true, () => false)).toBe(false);
});

test("v1 parser remains fail-closed compatible", async () => {
  const { prepared } = await fixture();
  const v1 = { ...prepared.journal, version: 1, phase: "prepared" };
  const parsed = parseStateCasJournal(`${JSON.stringify(v1)}\n`, prepared.journalPath);
  expect(parsed).toMatchObject({ version: 1, phase: "prepared", txnId: prepared.journal.txnId });
});

test("loader refuses an oversized v1 journal at the v1 admission bound", async () => {
  const { prepared } = await fixture();
  await prepared.writer.close();
  const oversized = { ...prepared.journal, version: 1, phase: "prepared", padding: "x".repeat(1024 * 1024) };
  await fs.writeFile(prepared.journalPath, `${JSON.stringify(oversized)}\n`);
  expect(await loadStateCasJournals(root)).toEqual([{ path: prepared.journalPath }]);
});

test("new reader recovers and retires a valid v1 acquired journal", async () => {
  const { common, prepared } = await fixture();
  const lock = prepared.journal.commonDirs[0]!.locks[0]!;
  const published = await publishLockMarker(lock.path, lock.marker);
  expect(published.status).toBe("created");
  if (published.status !== "created") return;
  await prepared.writer.close();
  const v1 = structuredClone(prepared.journal) as typeof prepared.journal & { version: 1 };
  v1.version = 1;
  v1.phase = "locked";
  v1.commonDirs[0]!.locks[0]!.acquisition = "acquired";
  v1.commonDirs[0]!.locks[0]!.observation = serializeMarkerObservation(published.observation);
  await fs.writeFile(prepared.journalPath, `${JSON.stringify(v1)}\n`);
  const result = await recoverStateCasLocks(root, { commonDir: common, identity: identity("dead") });
  expect(result).toMatchObject({ recovered: 1, indeterminate: 0 });
  expect(await fs.lstat(lock.path).then(() => true, () => false)).toBe(false);
  expect(await fs.lstat(prepared.journalPath).then(() => true, () => false)).toBe(false);
});

test("released v1 parser retains a v2 journal fail-closed", async () => {
  const { prepared } = await fixture();
  const acquired = await acquirePreparedStateCasLocks(prepared);
  const raw = await fs.readFile(prepared.journalPath, "utf8");
  expect(parseV1(raw, prepared.journalPath)).toBeUndefined();
  expect(await fs.lstat(prepared.journalPath).then(() => true)).toBe(true);
  expect(await fs.lstat(prepared.journal.commonDirs[0]!.locks[0]!.path).then(() => true)).toBe(true);
});

test("strict v2 fold rejects malformed middle, duplicate outcome, and misordered phase", async () => {
  const { prepared } = await fixture();
  await acquirePreparedStateCasLocks(prepared);
  const lines = (await fs.readFile(prepared.journalPath, "utf8")).trimEnd().split("\n");
  const malformedMiddle = [lines[0], "{broken", ...lines.slice(1)].join("\n") + "\n";
  const duplicateOutcome = [lines[0], lines[1], lines[1], ...lines.slice(2)].join("\n") + "\n";
  const misorderedPhase = [lines[0], JSON.stringify({ type: "committed" }), ...lines.slice(1)].join("\n") + "\n";
  expect(parseStateCasJournal(malformedMiddle, prepared.journalPath)).toBeUndefined();
  expect(parseStateCasJournal(duplicateOutcome, prepared.journalPath)).toBeUndefined();
  expect(parseStateCasJournal(misorderedPhase, prepared.journalPath)).toBeUndefined();
});

test("strict v2 fold rejects duplicate and out-of-range ordinals", async () => {
  const { prepared } = await fixture(2);
  await acquirePreparedStateCasLocks(prepared);
  const lines = (await fs.readFile(prepared.journalPath, "utf8")).trimEnd().split("\n");
  const duplicate = [lines[0], lines[1], lines[1], ...lines.slice(2)].join("\n") + "\n";
  const outOfRange = [...lines];
  outOfRange[1] = JSON.stringify({ ...JSON.parse(outOfRange[1]!) as object, ordinal: 2 });
  expect(parseStateCasJournal(duplicate, prepared.journalPath)).toBeUndefined();
  expect(parseStateCasJournal(`${outOfRange.join("\n")}\n`, prepared.journalPath)).toBeUndefined();
});

test("strict v2 fold rejects a forged header above the lock cap", async () => {
  const { prepared } = await fixture();
  const header = JSON.parse((await fs.readFile(prepared.journalPath, "utf8")).trimEnd()) as {
    commonDirs: Array<{ locks: Array<{ path: string; marker: string; proofs: unknown[] }> }>;
  };
  const template = header.commonDirs[0]!.locks[0]!;
  header.commonDirs[0]!.locks = Array.from({ length: 4097 }, (_, index) => ({
    ...template,
    path: path.join(path.dirname(template.path), `${index}.lock`),
  }));
  expect(parseStateCasJournal(`${JSON.stringify(header)}\n`, prepared.journalPath)).toBeUndefined();
});

test("one torn final append is ignored and copied-marker replacement remains stale", async () => {
  const { common, prepared } = await fixture();
  const lock = prepared.journal.commonDirs[0]!.locks[0]!;
  const published = await publishLockMarker(lock.path, lock.marker);
  expect(published.status).toBe("created");
  await fs.appendFile(prepared.journalPath, `{"type":"acquisition","ordinal":0`);
  await fs.unlink(lock.path);
  await fs.writeFile(lock.path, lock.marker);
  const result = await recoverStateCasLocks(root, { commonDir: common, identity: identity("dead") });
  expect(result).toMatchObject({ recovered: 0, stale: 1 });
  expect(await fs.readFile(lock.path, "utf8")).toBe(lock.marker);
  expect(await fs.lstat(prepared.journalPath).then(() => true)).toBe(true);
  await fs.unlink(lock.path);
  expect(await recoverStateCasLocks(root, { commonDir: common, identity: identity("dead") })).toMatchObject({ indeterminate: 0 });
  expect(await fs.lstat(prepared.journalPath).then(() => true, () => false)).toBe(false);
});

test("each JSONL append completes fdatasync before its appended seam", async () => {
  const { prepared } = await fixture(2);
  let datasyncs = 0;
  const seamCounts: number[] = [];
  await acquirePreparedStateCasLocks(prepared, {
    journalHooks: { afterDatasync: () => { datasyncs++; } },
    afterLockAppended: () => { seamCounts.push(datasyncs); },
  });
  expect(datasyncs).toBe(3);
  expect(seamCounts).toEqual([1, 2]);
});

test("retained-fd path mismatch cleans every link, retains authority, and suppresses hook", async () => {
  const { prepared } = await fixture();
  const header = await fs.readFile(prepared.journalPath);
  let appendedHook = false;
  await expect(acquirePreparedStateCasLocks(prepared, {
    journalHooks: { afterDatasync: async (journalPath) => {
      await fs.unlink(journalPath);
      await fs.writeFile(journalPath, header);
    } },
    afterLockAppended: () => { appendedHook = true; },
  })).rejects.toThrow("path binding changed");
  expect(appendedHook).toBe(false);
  expect(await fs.lstat(prepared.journal.commonDirs[0]!.locks[0]!.path).then(() => true, () => false)).toBe(false);
  expect(await fs.lstat(prepared.journalPath).then(() => true)).toBe(true);
});

test("blocked outcome records a bounded holder marker separate from the transaction marker", async () => {
  const { prepared } = await fixture();
  const lock = prepared.journal.commonDirs[0]!.locks[0]!;
  const holder = formatLockMarker({ ...OWNER, pid: 99, startTime: "2", token: "c".repeat(32) });
  expect((await publishLockMarker(lock.path, holder)).status).toBe("created");
  await acquirePreparedStateCasLocks(prepared);
  const parsed = parseStateCasJournal(await fs.readFile(prepared.journalPath, "utf8"), prepared.journalPath);
  expect(parsed?.commonDirs[0]?.locks[0]).toMatchObject({ marker: lock.marker, acquisition: "blocked", holderMarker: holder });
});

test("raced-away blocker records holderMarker unknown", async () => {
  const { prepared } = await fixture();
  const lock = prepared.journal.commonDirs[0]!.locks[0]!;
  await fs.mkdir(path.dirname(lock.path), { recursive: true });
  await fs.writeFile(lock.path, "foreign\n");
  await acquirePreparedStateCasLocks(prepared, {
    hooks: { link: async (_source, destination) => {
      await fs.unlink(destination);
      throw Object.assign(new Error("raced EEXIST"), { code: "EEXIST" });
    } },
  });
  const parsed = parseStateCasJournal(await fs.readFile(prepared.journalPath, "utf8"), prepared.journalPath);
  expect(parsed?.commonDirs[0]?.locks[0]?.holderMarker).toBe("unknown");
});
