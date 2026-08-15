import { expect, spyOn, test } from "bun:test";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLock, OwnedLock } from "../../engine/lockfile.js";
import { ensureTelemetryBindingId, loadState, saveStateUnsafeLegacyOrTest, type SyncState } from "../config.js";
import { authorityMarkerBytes } from "../state-plane/authority-marker.js";
import { StateAuthorityCorruptError } from "../state-plane/errors.js";
import { sqliteResetPaths, stateLockPath, statePath } from "../state-plane/paths.js";
import * as storeFacade from "../state-plane/store-facade.js";
import { createStateStore, ownedStateStoreWriterForReset } from "../state-plane/store/open.js";
import { buildSyncStateSummary, SyncStateReporter } from "./sync-state.js";

const manifest = { generatedAt: "", files: [] };
const authority = "a".repeat(32);
const lineage = "b".repeat(32);
const nonce = "c".repeat(32);

async function qWorkspace(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `rbox-telemetry-q-${prefix}-`));
  await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  createStateStore(sqliteResetPaths.active(root), {
    authorityId: authority,
    lineageId: lineage,
    stream: "s",
    createdBy: "test",
    stateNonce: nonce,
    stateRevision: 0,
  }).close();
  await fs.writeFile(statePath(root), authorityMarkerBytes(authority));
  return root;
}

function stateDirectoryBytes(root: string): Record<string, string> {
  return Object.fromEntries(fsSync.readdirSync(sqliteResetPaths.stateRoot(root)).sort().map((name) => {
    const file = path.join(sqliteResetPaths.stateRoot(root), name);
    return [name, fsSync.statSync(file).isDirectory() ? "<dir>" : fsSync.readFileSync(file).toString("base64")];
  }));
}

test("summary uses repo projection and emits explicit null when no repo is deferred", () => {
  const clean: SyncState = { stream: "s", lastSyncedSequence: 7, lastSyncedManifest: manifest, repoRecords: {
    a: { repoGen: 0, sourceSeq: 7 }, b: { repoGen: 0, sourceSeq: 7 },
  }};
  expect(buildSyncStateSummary({ remoteWorkspaceId: "ws", projectId: "p" }, clean, "0011223344556677", 10_000)).toEqual({
    workspaceId: "ws", projectId: "p", bindingId: "0011223344556677", fileSeq: 7,
    reposTotal: 2, reposDeferred: 0, oldestDeferralAgeMs: null, deferralReasons: [],
  });
  const deferred: SyncState = { ...clean, repoRecords: { ...clean.repoRecords!, a: { repoGen: 0, sourceSeq: 7, deferrals: {
    apply: { lane: "apply", deferredSince: new Date(1_000).toISOString(), reasonSince: new Date(1_000).toISOString(), lastSeen: new Date(1_000).toISOString(), reason: "local-edits" },
    capture: { lane: "capture", deferredSince: new Date(2_000).toISOString(), reasonSince: new Date(2_000).toISOString(), lastSeen: new Date(2_000).toISOString(), reason: "git-busy" },
  }}}};
  const summary = buildSyncStateSummary({ remoteWorkspaceId: "ws", projectId: "p" }, deferred, "0011223344556677", 10_000);
  expect(summary.reposDeferred).toBe(1);
  expect(summary.oldestDeferralAgeMs).toBe(9_000);
  expect(summary.deferralReasons).toEqual(["git-busy", "local-edits"]);
});

test("T1-T2: JSON reuses or deterministically mints one binding without changing sync state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-telemetry-state-"));
  try {
    await saveStateUnsafeLegacyOrTest(root, { stream: "s", lastSyncedSequence: 0, lastSyncedManifest: manifest });
    const random = () => Buffer.from("0011223344556677", "hex");
    const first = await ensureTelemetryBindingId(root, "s", random);
    const second = await ensureTelemetryBindingId(root, "s", () => Buffer.from("ffffffffffffffff", "hex"));
    expect(first.bindingId).toBe("0011223344556677");
    expect(second.bindingId).toBe(first.bindingId);
    expect((await loadState(root, "s")).telemetryBindingId).toBe(first.bindingId);
    const beforeReuse = await fs.readFile(path.join(root, ".rbox", "state.json"));
    await ensureTelemetryBindingId(root, "s", () => { throw new Error("existing binding must win"); });
    expect(await fs.readFile(path.join(root, ".rbox", "state.json"))).toEqual(beforeReuse);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("T14: JSON complete-tree golden stays byte-stable and does not statically import SQLite", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-telemetry-state-legacy-"));
  try {
    const legacy: SyncState = {
      lastSyncedSequence: 12,
      lastSyncedManifest: { generatedAt: "legacy", files: [{ path: "kept.txt", hash: "abc", size: 3 }] },
      repoRecords: { repo: { repoGen: 4, sourceSeq: 11 } },
    };
    await saveStateUnsafeLegacyOrTest(root, legacy);
    const result = await ensureTelemetryBindingId(root, "s", () => Buffer.from("0011223344556677", "hex"));
    expect(result.state).toEqual({ ...legacy, telemetryBindingId: "0011223344556677" });
    const golden = {
      ...legacy,
      telemetryBindingId: "0011223344556677",
    };
    expect(result.state).toEqual(golden);
    expect(await fs.readFile(path.join(root, ".rbox", "state.json"), "utf8"))
      .toBe(JSON.stringify(golden, null, 2));
    expect(result.state.stream).toBeUndefined();
    const adapter = await fs.readFile(path.join(import.meta.dir, "../state-plane/adapters/whole-state-compat.ts"), "utf8");
    expect(adapter).not.toMatch(/^import .*bun:sqlite/m);
    expect(adapter).not.toMatch(/^import .*store-facade/m);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("T5: binding mismatch refuses without mutation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-telemetry-state-mismatch-"));
  let uploads = 0;
  try {
    await saveStateUnsafeLegacyOrTest(root, { stream: "old", lastSyncedSequence: 7, lastSyncedManifest: manifest });
    const file = path.join(root, ".rbox", "state.json");
    const before = await fs.readFile(file);
    await expect(ensureTelemetryBindingId(root, "new", () => Buffer.from("0011223344556677", "hex"))).rejects.toThrow(
      "sync state belongs to stream old, not new",
    );
    expect(await fs.readFile(file)).toEqual(before);
    const reporter = new SyncStateReporter(root, { remoteWorkspaceId: "ws", projectId: "p", remoteUrl: "http://x" }, {
      postJson: async () => { uploads += 1; return new Response(null, { status: 202 }); },
    });
    reporter.afterSyncTick({ stream: "new", lastSyncedSequence: 7, lastSyncedManifest: manifest });
    await reporter.flushForTests();
    expect(uploads).toBe(0);
    expect(await fs.readFile(file)).toEqual(before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("T6: absent JSON refuses without manufacturing state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-telemetry-state-absent-"));
  try {
    await expect(ensureTelemetryBindingId(root, "s", () => Buffer.from("0011223344556677", "hex"))).rejects.toThrow(
      "sync state is absent",
    );
    await expect(fs.readFile(path.join(root, ".rbox", "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("T1-T4: Q reuses across reopen and concurrent first mint elects one winner", async () => {
  const root = await qWorkspace("reuse-concurrent");
  try {
    const [left, right] = await Promise.allSettled([
      ensureTelemetryBindingId(root, "s", () => Buffer.from("0011223344556677", "hex")),
      ensureTelemetryBindingId(root, "s", () => Buffer.from("8899aabbccddeeff", "hex")),
    ]);
    const firstWinner = [left, right].find((result) => result.status === "fulfilled");
    expect(firstWinner?.status).toBe("fulfilled");
    const durable = await ensureTelemetryBindingId(root, "s", () => Buffer.from("ffffffffffffffff", "hex"));
    expect(durable.bindingId).toMatch(/^(0011223344556677|8899aabbccddeeff)$/);
    const reopened = await ensureTelemetryBindingId(root, "s", () => { throw new Error("reopen must reuse winner"); });
    expect(reopened.bindingId).toBe(durable.bindingId);
    expect(reopened.state.stateRevision).toBe(0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("T3: a second process with a different random source reuses the durable Q winner", async () => {
  const root = await qWorkspace("second-process");
  try {
    const first = await ensureTelemetryBindingId(root, "s", () => Buffer.from("0011223344556677", "hex"));
    const modulePath = path.join(import.meta.dir, "../config.ts");
    const child = Bun.spawn([
      process.execPath,
      "-e",
      `const { ensureTelemetryBindingId } = await import(${JSON.stringify(modulePath)}); const result = await ensureTelemetryBindingId(${JSON.stringify(root)}, "s", () => Buffer.from("ffffffffffffffff", "hex")); console.log(result.bindingId);`,
    ], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout.trim()).toBe(first.bindingId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("T7: Q missing, foreign, and authority-mismatched stores refuse without mutation", async () => {
  const roots: string[] = [];
  try {
    const missing = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-telemetry-q-missing-"));
    roots.push(missing);
    await fs.mkdir(sqliteResetPaths.stateRoot(missing), { recursive: true });
    await fs.writeFile(statePath(missing), authorityMarkerBytes(authority));

    const foreign = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-telemetry-q-foreign-"));
    roots.push(foreign);
    await fs.mkdir(sqliteResetPaths.stateRoot(foreign), { recursive: true });
    await fs.writeFile(statePath(foreign), authorityMarkerBytes(authority));
    await fs.writeFile(sqliteResetPaths.active(foreign), "not sqlite");

    const mismatched = await qWorkspace("mismatched");
    roots.push(mismatched);
    await fs.writeFile(statePath(mismatched), authorityMarkerBytes("d".repeat(32)));

    for (const root of roots) {
      const before = stateDirectoryBytes(root);
      await expect(ensureTelemetryBindingId(root, "s")).rejects.toBeInstanceOf(StateAuthorityCorruptError);
      expect(stateDirectoryBytes(root)).toEqual(before);
    }
  } finally {
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  }
});

test("T8: held, unsupported, and erroneous Q locks cause no upload", async () => {
  const root = await qWorkspace("lock-outcomes");
  const state = (await loadState(root, "s"));
  let uploads = 0;
  const report = async (): Promise<void> => {
    const reporter = new SyncStateReporter(root, { remoteWorkspaceId: "ws", projectId: "p", remoteUrl: "http://x" }, {
      postJson: async () => { uploads += 1; return new Response(null, { status: 202 }); },
    });
    reporter.afterSyncTick(state);
    await reporter.flushForTests();
  };
  try {
    const held = await acquireLock(stateLockPath(root));
    expect(held.status).toBe("acquired");
    if (held.status === "acquired") {
      await report();
      await held.lock.release();
    }
    for (const [message, code] of [["unsupported", "EOPNOTSUPP"], ["I/O error", "EIO"]] as const) {
      const link = spyOn(fs, "link").mockRejectedValue(Object.assign(new Error(message), { code }));
      try { await report(); } finally { link.mockRestore(); }
    }
    expect(uploads).toBe(0);
    expect((await loadState(root, "s")).telemetryBindingId).toBeUndefined();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("T9-T10: Q owner loss and pre-commit throw roll back; retry mints once", async () => {
  const ownerLossRoot = await qWorkspace("owner-loss");
  const preCommitRoot = await qWorkspace("pre-commit");
  try {
    let checks = 0;
    const owner = spyOn(OwnedLock.prototype, "isOwnerSync").mockImplementation(() => checks++ < 2);
    try {
      await expect(ensureTelemetryBindingId(
        ownerLossRoot,
        "s",
        () => Buffer.from("0011223344556677", "hex"),
      )).rejects.toThrow("ownership was lost");
    } finally {
      owner.mockRestore();
    }
    expect((await loadState(ownerLossRoot, "s")).telemetryBindingId).toBeUndefined();

    await expect(ensureTelemetryBindingId(preCommitRoot, "s", () => {
      throw new Error("crash before commit");
    })).rejects.toThrow("crash before commit");
    expect((await loadState(preCommitRoot, "s")).telemetryBindingId).toBeUndefined();
    expect((await ensureTelemetryBindingId(
      preCommitRoot,
      "s",
      () => Buffer.from("8899aabbccddeeff", "hex"),
    )).bindingId).toBe("8899aabbccddeeff");
  } finally {
    await fs.rm(ownerLossRoot, { recursive: true, force: true });
    await fs.rm(preCommitRoot, { recursive: true, force: true });
  }
});

test("T11-T12: commit precedes materialization, close, and reporter upload", async () => {
  const root = await qWorkspace("ordering");
  const state = await loadState(root, "s");
  const events: string[] = [];
  const originalEnsure = storeFacade.ensureStoreTelemetryBindingId;
  const originalMaterialize = storeFacade.loadRawStateFromStore;
  const commit = spyOn(storeFacade, "ensureStoreTelemetryBindingId").mockImplementation((...args) => {
    const result = originalEnsure(...args);
    events.push("commit");
    return result;
  });
  const materialize = spyOn(storeFacade, "loadRawStateFromStore").mockImplementation((...args) => {
    const result = originalMaterialize(...args);
    events.push("materialize");
    return result;
  });
  try {
    const reporter = new SyncStateReporter(root, { remoteWorkspaceId: "ws", projectId: "p", remoteUrl: "http://x" }, {
      postJson: async () => {
        expect(ownedStateStoreWriterForReset(sqliteResetPaths.active(root))).toBeUndefined();
        events.push("close");
        events.push("upload");
        return new Response('{"accepted":1,"dropped":0}', { status: 202 });
      },
    });
    reporter.afterSyncTick(state);
    await reporter.flushForTests();
    expect(events).toEqual(["commit", "materialize", "close", "upload"]);
    expect((await loadState(root, "s")).telemetryBindingId).toBeDefined();
  } finally {
    commit.mockRestore();
    materialize.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("T11: a post-commit materialization failure keeps the binding and suppresses upload", async () => {
  const root = await qWorkspace("post-commit");
  let uploads = 0;
  const materialize = spyOn(storeFacade, "loadRawStateFromStore")
    .mockImplementationOnce(() => { throw new Error("after commit"); });
  try {
    const state: SyncState = { stream: "s", lastSyncedSequence: 0, lastSyncedManifest: manifest };
    const reporter = new SyncStateReporter(root, { remoteWorkspaceId: "ws", projectId: "p", remoteUrl: "http://x" }, {
      postJson: async () => { uploads += 1; return new Response(null, { status: 202 }); },
    });
    reporter.afterSyncTick(state);
    await reporter.flushForTests();
  } finally {
    materialize.mockRestore();
  }
  try {
    expect(uploads).toBe(0);
    expect((await loadState(root, "s")).telemetryBindingId).toBeDefined();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("T13: transport throw and non-202 retain the Q binding and retry cadence", async () => {
  const root = await qWorkspace("transport");
  const state = await loadState(root, "s");
  const logs: string[] = [];
  let calls = 0;
  try {
    const reporter = new SyncStateReporter(root, { remoteWorkspaceId: "ws", projectId: "p", remoteUrl: "http://x" }, {
      postJson: async () => {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        if (calls === 2) return new Response(null, { status: 503 });
        return new Response('{"accepted":1,"dropped":0}', { status: 202 });
      },
    }, (line) => logs.push(line));
    reporter.heartbeat(state);
    await reporter.flushForTests();
    const binding = (await loadState(root, "s")).telemetryBindingId;
    expect(binding).toBeDefined();
    reporter.heartbeat(state);
    await reporter.flushForTests();
    expect((await loadState(root, "s")).telemetryBindingId).toBe(binding);
    reporter.heartbeat(state);
    await reporter.flushForTests();
    expect(calls).toBe(3);
    expect(logs).toEqual([
      "sync-state report failed (1 attempt)",
      "sync-state report failed (2 attempts)",
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reporter gates unchanged ticks despite advancing age and still sends a heartbeat", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-telemetry-report-"));
  let now = 10_000;
  let calls = 0;
  try {
    const state: SyncState = { stream: "s", lastSyncedSequence: 1, lastSyncedManifest: manifest, repoRecords: {} };
    await saveStateUnsafeLegacyOrTest(root, state);
    const reporter = new SyncStateReporter(root, { remoteWorkspaceId: "ws", projectId: "p", remoteUrl: "http://x" }, {
      postJson: async () => { calls++; return new Response('{"accepted":1,"dropped":0}', { status: 202 }); },
    }, () => {}, () => now);
    reporter.afterSyncTick(state);
    await reporter.flushForTests();
    now += 5_000;
    reporter.afterSyncTick(state);
    await reporter.flushForTests();
    expect(calls).toBe(1);
    reporter.heartbeat(state);
    await reporter.flushForTests();
    expect(calls).toBe(2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("reporter kill switch performs no network call", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-telemetry-off-"));
  let calls = 0;
  process.env.RBOX_TELEMETRY = "0";
  try {
    const state: SyncState = { stream: "s", lastSyncedSequence: 0, lastSyncedManifest: manifest };
    const reporter = new SyncStateReporter(root, { remoteWorkspaceId: "ws", projectId: "p", remoteUrl: "http://x" }, {
      postJson: async () => { calls++; return new Response(null, { status: 202 }); },
    });
    reporter.afterSyncTick(state);
    await reporter.flushForTests();
    expect(calls).toBe(0);
  } finally {
    delete process.env.RBOX_TELEMETRY;
    await fs.rm(root, { recursive: true, force: true });
  }
});
