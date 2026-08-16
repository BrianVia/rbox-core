/** Design 269 §2.1-§2.4: what the composer emits, when it is allowed to, and the
 * op-equivalence that makes the ops and the whole manifest one derivation. */
import { afterEach, expect, test } from "bun:test";
import type { FileEntry, Manifest } from "../engine/index.js";
import type { DeltaOp, SyncState } from "./sync-state-model.js";
import {
  applyDeltaOps, composeGlobalDelta, deltaBindingFor, noteCompleteSaveAccepted,
  observeGlobalContentDrift, resetObservedDriftForTests, saveDeltaEnabled,
} from "./sync-state-delta.js";
import { composeStateSavePacket, type StateSource } from "./sync-state.js";

const STREAM = "https://api.test::ws_269::root";
const NONCE = "a".repeat(32);
const hex = (width: number, value: number): string => value.toString(16).padStart(width, "0");

afterEach(() => {
  resetObservedDriftForTests();
  delete process.env.RBOX_SAVE_DELTA;
});

function entry(name: string, seed: number): FileEntry {
  return { path: name, sha256: hex(64, seed), size: seed, mode: 0o644, mtimeMs: seed + 0.5, type: "file" } as FileEntry;
}

const manifest = (files: FileEntry[]): Manifest => ({
  generatedAt: "2026-08-16T00:00:00.000Z", manifestSchema: 2, files,
} as Manifest);

function snapshot(files: FileEntry[], overrides: Partial<SyncState> = {}): SyncState {
  return {
    stream: STREAM, lastSyncedSequence: 1, lastSyncedManifest: manifest(files),
    stateNonce: NONCE, stateRevision: 3, ...overrides,
  };
}

function source(files: FileEntry[], overrides: Partial<StateSource> = {}): StateSource {
  return {
    expectedStream: STREAM, sourceGlobalSeq: 2, globalManifest: manifest(files),
    observedRepos: [], values: {}, baseIsUnscopedRemote: true, ...overrides,
  };
}

/** A churn corpus that exercises every op shape at once: head/tail/middle
 * insertions, deletions, value changes, and untouched runs. */
function corpus(): Array<{ name: string; before: FileEntry[]; after: FileEntry[] }> {
  const run = Array.from({ length: 40 }, (_, index) => entry(`files/${String(index).padStart(4, "0")}.bin`, index + 1));
  const changed = run.map((file, index) => (index === 17 ? entry(file.path, 900) : file));
  return [
    { name: "identical", before: run, after: run },
    { name: "one changed", before: run, after: changed },
    { name: "head insert", before: run, after: [entry("aaa.bin", 5), ...run] },
    { name: "tail insert", before: run, after: [...run, entry("zzz.bin", 6)] },
    { name: "middle delete", before: run, after: run.filter((_, index) => index !== 12) },
    { name: "empty to full", before: [], after: run },
    { name: "full to empty", before: run, after: [] },
    {
      name: "mixed churn",
      before: run,
      after: [entry("aaa.bin", 7), ...changed.filter((_, index) => index % 5 !== 0), entry("zzz.bin", 8)],
    },
  ];
}

test("the ops and the whole manifest are one derivation across a churn corpus", () => {
  for (const { name, before, after } of corpus()) {
    const delta = composeGlobalDelta(before, after, { nonce: NONCE, stateRevision: 3 });
    expect(delta, name).toBeDefined();
    expect(applyDeltaOps(before, delta!.ops), name).toEqual(after);
    const paths = delta!.ops.map((op) => (op.kind === "upsert" ? op.entry.path : op.path));
    expect([...paths].sort(), name).toEqual(paths);
    expect(new Set(paths).size, name).toBe(paths.length);
  }
});

test("an unchanged manifest composes a zero-op delta rather than no delta", () => {
  const files = [entry("a.txt", 1)];
  const delta = composeGlobalDelta(files, files, { nonce: NONCE, stateRevision: 3 });
  expect(delta?.ops).toEqual([]);
});

test("a predecessor or successor that is not strictly ascending composes no delta", () => {
  const binding = { nonce: NONCE, stateRevision: 3 };
  const unsorted = [entry("b.txt", 1), entry("a.txt", 2)];
  const duplicated = [entry("a.txt", 1), entry("a.txt", 2)];
  expect(composeGlobalDelta(unsorted, [entry("a.txt", 1)], binding)).toBeUndefined();
  expect(composeGlobalDelta([entry("a.txt", 1)], unsorted, binding)).toBeUndefined();
  expect(composeGlobalDelta(duplicated, [entry("a.txt", 1)], binding)).toBeUndefined();
});

test("applying a delete of a path the predecessor does not hold is a refusal", () => {
  const ops: DeltaOp[] = [{ kind: "delete", path: "missing.txt" }];
  expect(() => applyDeltaOps([entry("a.txt", 1)], ops)).toThrow("does not hold");
});

test("eligibility requires the switch, an audit-covered base, a bound snapshot, and no standing heal", () => {
  const state = snapshot([entry("a.txt", 1)]);
  const eligible = { baseIsUnscopedRemote: true };
  expect(deltaBindingFor(state, eligible)).toEqual({ nonce: NONCE, stateRevision: 3 });

  expect(deltaBindingFor(state, {})).toBeUndefined();
  expect(deltaBindingFor(state, { baseIsUnscopedRemote: false })).toBeUndefined();
  expect(deltaBindingFor(state, { ...eligible, replacesStream: true })).toBeUndefined();
  expect(deltaBindingFor(snapshot([], { stateNonce: undefined }), eligible)).toBeUndefined();
  expect(deltaBindingFor(snapshot([], { stateNonce: "legacy" }), eligible)).toBeUndefined();
  expect(deltaBindingFor(snapshot([], { stateRevision: undefined }), eligible)).toBeUndefined();

  process.env.RBOX_SAVE_DELTA = "0";
  expect(saveDeltaEnabled()).toBe(false);
  expect(deltaBindingFor(state, eligible)).toBeUndefined();
});

test("observed content drift forces complete saves for THAT stream until one is accepted", () => {
  const state = snapshot([entry("a.txt", 1)]);
  const other = snapshot([entry("a.txt", 1)], { stream: `${STREAM}::other` });
  const eligible = { baseIsUnscopedRemote: true };

  observeGlobalContentDrift(state.stream);
  expect(deltaBindingFor(state, eligible)).toBeUndefined();
  // A second workspace in the same process has its own base and its own audit.
  expect(deltaBindingFor(other, eligible)).toBeDefined();

  noteCompleteSaveAccepted(other.stream);
  expect(deltaBindingFor(state, eligible)).toBeUndefined();
  noteCompleteSaveAccepted(state.stream);
  expect(deltaBindingFor(state, eligible)).toBeDefined();
});

test("a composed packet carries the whole manifest AND the ops, bound to the snapshot", () => {
  const before = [entry("a.txt", 1), entry("b.txt", 2)];
  const after = [entry("a.txt", 1), entry("c.txt", 3)];
  const packet = composeStateSavePacket(snapshot(before), source(after));

  expect(packet.global?.manifest.files).toEqual(after);
  expect(packet.globalDelta?.binding).toEqual({ nonce: NONCE, stateRevision: 3 });
  expect(packet.globalDelta?.ops).toEqual([
    { kind: "delete", path: "b.txt" },
    { kind: "upsert", entry: entry("c.txt", 3) },
  ]);
  expect(applyDeltaOps(before, packet.globalDelta!.ops)).toEqual(packet.global!.manifest.files);
});

test("an ineligible source composes the same packet it always did, with no ops", () => {
  const before = [entry("a.txt", 1)];
  const after = [entry("a.txt", 9)];
  const scoped = composeStateSavePacket(snapshot(before), source(after, { baseIsUnscopedRemote: undefined }));
  expect(scoped.global?.manifest.files).toEqual(after);
  expect(scoped.globalDelta).toBeUndefined();

  const drifted = snapshot(before);
  observeGlobalContentDrift(drifted.stream);
  const healing = composeStateSavePacket(drifted, source(after));
  expect(healing.global?.manifest.files).toEqual(after);
  expect(healing.globalDelta).toBeUndefined();
});

test("a repo-only save composes no delta because it carries no global", () => {
  const packet = composeStateSavePacket(snapshot([entry("a.txt", 1)]), {
    expectedStream: STREAM, sourceGlobalSeq: 2, observedRepos: [], values: {}, baseIsUnscopedRemote: true,
  });
  expect(packet.global).toBeUndefined();
  expect(packet.globalDelta).toBeUndefined();
});
