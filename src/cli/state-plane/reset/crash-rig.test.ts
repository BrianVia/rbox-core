import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resetQuarantineRoot,
  resumeResetQuarantinesUnderFence,
} from "../../reset-quarantine.js";
import {
  classifyModeledZeroRefTree,
  DurableTree,
  type ModeledResetRow,
} from "./crash-rig-model.js";
import {
  createSqliteResetRecoveryFs,
  type SqliteResetFsTraceEvent,
} from "./recovery.js";
import { Database } from "bun:sqlite";
import { validateOpen } from "../schema/validate-open.js";
import { createStateStore } from "../store/open.js";
import { sqliteResetPaths } from "./artifacts.js";
import { sqliteResetFacade } from "./index.js";
import { fsyncDirectory } from "../../../engine/fsutil.js";

const beginSqliteReset = sqliteResetFacade.begin;
const inspectSqliteReset = sqliteResetFacade.inspect;
const recoverSqliteReset = sqliteResetFacade.recover;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const QUARANTINE_BOUNDARIES = [
  "after-manifest-publish",
  "after-journal-copy",
  "after-candidate-copy",
  "after-archive-copy",
  "after-manifest-fsync",
  "before-commit-publish",
  "after-commit-temp-fsync",
  "after-commit-rename",
  "after-commit-publish",
  "after-journal-remove",
  "after-candidate-remove",
] as const;

async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) out[relative] = (await fs.readFile(file)).toString("hex");
      else out[relative] = `<${entry.isSymbolicLink() ? "symlink" : "special"}>`;
    }
  }
  await walk(root);
  return out;
}

describe("U2 fresh-process SIGKILL rig", () => {
  test("P0A pre-existing archive baseline survives actual SIGKILL and resumes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-u2-p0a-kill-"));
    roots.push(root);
    const child = Bun.spawn({
      cmd: [process.execPath, import.meta.dir + "/crash-rig-child.ts", "reset-production-p0a", root, "after-prepared"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect([9, 137]).toContain(await child.exited);
    expect(await inspectSqliteReset(root, "old")).toMatchObject({
      status: "recoverable",
      row: { ids: ["P0A"] },
    });
    expect(await recoverSqliteReset(root, "old")).toBe("complete");
  });

  for (const boundary of [
    "after-backup-staging-fsync",
    "after-backup-link",
    "after-backup-source-unlink",
    "after-backup-publication",
  ]) {
    test(`backup publication is absent-or-exact after actual SIGKILL at ${boundary}`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-u2-backup-kill-"));
      roots.push(root);
      const child = Bun.spawn({
        cmd: [process.execPath, import.meta.dir + "/crash-rig-child.ts", "backup-production", root, boundary],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect([9, 137]).toContain(await child.exited);
      const destination = path.join(root, ".rbox", "state", "backups", "snapshot.db");
      const exists = await fs.lstat(destination).then((stat) => stat.isFile(), () => false);
      if (exists) {
        const backup = new Database(destination, { readonly: true });
        try { validateOpen(backup, destination); } finally { backup.close(); }
      }
      expect(exists).toBe(boundary !== "after-backup-staging-fsync");
      expect(await fs.lstat(`${destination}-wal`).catch(() => undefined)).toBeUndefined();
      expect(await fs.lstat(`${destination}-shm`).catch(() => undefined)).toBeUndefined();
    });
  }

  test("W1 checkpoint survives actual SIGKILL and converges through production takeover", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-u2-w1-kill-"));
    roots.push(root);
    const prepare = Bun.spawn({
      cmd: [process.execPath, import.meta.dir + "/crash-rig-child.ts", "w1-prepare", root, "prepare"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect([9, 137]).toContain(await prepare.exited);
    expect((await inspectSqliteReset(root, "old")).status).toBe("w1");

    const takeover = Bun.spawn({
      cmd: [process.execPath, import.meta.dir + "/crash-rig-child.ts", "w1-takeover", root, "after-w1-checkpoint"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect([9, 137]).toContain(await takeover.exited);
    expect(["w1", "steady"]).toContain((await inspectSqliteReset(root, "old")).status);
    const result = await recoverSqliteReset(root, "old");
    expect(["none", "complete"]).toContain(result);
    expect((await inspectSqliteReset(root, "old")).status).toBe("steady");
  });

  for (const boundary of QUARANTINE_BOUNDARIES) {
    test(`quarantine resumes after actual SIGKILL at ${boundary}`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-u2-kill-"));
      roots.push(root);
      const child = Bun.spawn({
        cmd: [process.execPath, import.meta.dir + "/crash-rig-child.ts", "quarantine", root, boundary],
        stdout: "pipe",
        stderr: "pipe",
      });
      const exit = await child.exited;
      expect(exit).not.toBe(0);
      expect(exit === 137 || exit === 9).toBe(true);

      const killedTree = await snapshot(root);
      expect(killedTree[".rbox/state/state.db"]).toBe(Buffer.from("ACTIVE-DB\n").toString("hex"));
      expect(Object.keys(killedTree).some((name) => /\.db-(?:wal|shm|journal)$/.test(name))).toBe(false);

      await resumeResetQuarantinesUnderFence(root);
      const restartedTree = await snapshot(root);
      const committed = [
        "after-commit-rename",
        "after-commit-publish",
        "after-journal-remove",
        "after-candidate-remove",
      ].includes(boundary);
      expect(restartedTree[".rbox/state/state.db"]).toBe(Buffer.from("ACTIVE-DB\n").toString("hex"));
      expect(restartedTree[`.rbox/state/lineages/${"a".repeat(32)}/${"b".repeat(64)}.db`])
        .toBe(Buffer.from("ARCHIVE-DB\n").toString("hex"));
      expect(restartedTree[".rbox/state/reset-v1.json"] !== undefined).toBe(!committed);
      expect(restartedTree[`.rbox/state/reset-candidates/${"1".repeat(32)}.db`] !== undefined).toBe(!committed);
      const bundles = await fs.readdir(resetQuarantineRoot(root)).catch(() => []);
      expect(bundles.length).toBe(committed ? 1 : 0);
    });
  }

  for (const [boundary, expected] of [
    ["after-prepared", "P0"],
    ["after-candidate-create", "P1"],
    ["after-archive-create", "P2"],
    ["after-recovery-ref-1", "P3.1"],
    ["after-recovery-ref-2", "P3.2"],
    ["after-ready", "R0"],
    ["after-candidate-rename", "R1"],
    ["after-destination-parent-fsync", "R1"],
    ["after-source-unlink", "R1"],
    ["after-source-parent-fsync", "R1"],
    ["after-installed", "I0"],
    ["after-state-check", "I0"],
    ["after-marker-write", "I2"],
    ["after-active-group-1", "I3.1"],
    ["after-active-group-2", "I3.2"],
    ["after-z-retired", "Z0"],
    ["after-journal-unlink", "steady"],
  ] as const) {
    test(`reset DB tree is ${expected} after actual SIGKILL at ${boundary}`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-u2-reset-kill-"));
      roots.push(root);
      const child = Bun.spawn({
        cmd: [process.execPath, import.meta.dir + "/crash-rig-child.ts", "reset-production", root, boundary],
        stdout: "pipe",
        stderr: "pipe",
      });
      const exit = await child.exited;
      expect(exit === 137 || exit === 9).toBe(true);
      const tree = await snapshot(root);
      const inspection = await inspectSqliteReset(root, "old");
      const actual = inspection.status === "recoverable"
        ? inspection.row.ids[0]
        : inspection.status;
      expect(actual).toBe(expected);
      expect(Object.keys(tree).some((name) => /\.db-(?:wal|shm|journal)$/.test(name))).toBe(false);
      if (expected !== "steady") expect(await recoverSqliteReset(root, "old")).toBe("complete");
    });
  }
});

function publish(tree: DurableTree, destination: string, bytes: string): void {
  const parent = path.posix.dirname(destination);
  const temp = `${parent}/.rbox-tmp-7-1-${path.posix.basename(destination)}`;
  tree.write(temp, bytes);
  tree.fsyncFile(temp);
  tree.rename(temp, destination);
  tree.fsyncDir(parent);
}

describe("U2 modeled durable power cuts", () => {
  test("production writer trace replays every zero-ref power cut on real trees", async () => {
    const cases = [
      ["after-prepared", "P0"],
      ["after-candidate-create", "P1"],
      ["after-archive-create", "P2"],
      ["after-ready", "R0"],
      ["after-candidate-rename", "R0"],
      ["after-destination-parent-fsync", "R2"],
      ["after-source-unlink", "R2"],
      ["after-source-parent-fsync", "R1"],
      ["after-installed", "I0"],
      ["after-state-check", "I0"],
      ["after-marker-write", "I2"],
      ["after-z-retired", "Z0"],
      ["after-journal-unlink", "steady"],
    ] as const;
    for (const [boundary, expected] of cases) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-u2-production-trace-"));
      const replay = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-u2-production-replay-"));
      roots.push(root, replay);
      const authorityId = "a".repeat(32);
      await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
      await fs.writeFile(sqliteResetPaths.authorityMarker(root), `RBOX-SQLITE-AUTHORITY-v1\n${authorityId}\n`);
      createStateStore(sqliteResetPaths.active(root), {
        stream: "old", authorityId, lineageId: "1".repeat(32),
        stateNonce: "1".repeat(32), stateRevision: 1, createdBy: "power-cut-rig",
      }).close();
      if (boundary !== "after-prepared") {
        await beginSqliteReset(root, "next", [], {
          version: 2, authorizedNextStream: "next",
          consentKind: "setup-rebind", mintedAtRevision: 1,
        });
        await fs.rm(path.dirname(sqliteResetPaths.candidate(root, "0".repeat(32))), { recursive: true, force: true });
        await fsyncDirectory(sqliteResetPaths.stateRoot(root));
      }

      const durableFiles = new Map<string, Buffer>();
      const durableDirectories = new Set<string>();
      const pending = new Map<string, Array<{ file: string; bytes?: Buffer }>>();
      async function seed(directory: string): Promise<void> {
        durableDirectories.add(path.resolve(directory));
        for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await seed(file);
          else if (entry.isFile()) durableFiles.set(path.resolve(file), await fs.readFile(file));
        }
      }
      await seed(root);
      const queue = (parent: string, file: string, bytes?: Uint8Array): void => {
        const operations = pending.get(path.resolve(parent)) ?? [];
        operations.push({ file: path.resolve(file), ...(bytes === undefined ? {} : { bytes: Buffer.from(bytes) }) });
        pending.set(path.resolve(parent), operations);
      };
      const commitParent = (parent: string): void => {
        for (const operation of pending.get(path.resolve(parent)) ?? []) {
          if (operation.bytes === undefined) durableFiles.delete(operation.file);
          else durableFiles.set(operation.file, operation.bytes);
        }
        pending.delete(path.resolve(parent));
      };
      const trace: string[] = [];
      const observe = (event: SqliteResetFsTraceEvent): void => {
        trace.push(event.kind === "file-published"
          ? `${event.kind}:${path.relative(root, event.file)}:${event.bytes.byteLength}`
          : JSON.stringify(event));
        if (event.kind === "file-published") {
          queue(path.dirname(event.file), event.file, event.bytes);
        } else if (event.kind === "file-removed") {
          queue(path.dirname(event.file), event.file);
        } else if (event.kind === "directory-fsynced") {
          commitParent(event.directory);
        } else if (event.kind === "created-ancestors-fsynced") {
          for (const directory of event.created) durableDirectories.add(path.resolve(directory));
        }
      };
      const recordingFs = createSqliteResetRecoveryFs(observe);
      const crashAt = (point: string): void => {
        if (point === boundary) throw new Error(point);
      };
      if (boundary === "after-prepared") {
        await expect(beginSqliteReset(root, "next", [], {
          version: 2, authorizedNextStream: "next",
          consentKind: "setup-rebind", mintedAtRevision: 1,
        }, { recoveryFs: recordingFs, crashAt })).rejects.toThrow(boundary);
      } else {
        await expect(recoverSqliteReset(root, "old", {
          recoveryFs: recordingFs,
          crashAt,
        })).rejects.toThrow(boundary);
      }

      for (const directory of [...durableDirectories].sort((a, b) => a.length - b.length)) {
        await fs.mkdir(path.join(replay, path.relative(root, directory)), { recursive: true });
      }
      for (const [file, bytes] of durableFiles) {
        const parent = path.dirname(file);
        if (!durableDirectories.has(parent)) continue;
        const target = path.join(replay, path.relative(root, file));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
      }
      const inspection = await inspectSqliteReset(replay, "old");
      const actual = inspection.status === "recoverable" ? inspection.row.ids[0] : inspection.status;
      expect(actual, `${boundary}\n${trace.join("\n")}`).toBe(expected);
    }
  });

  test("discarding non-fsynced writes yields only correlated reset rows", () => {
    const tree = new DurableTree();
    tree.seed("state/state.db", "O");
    const observations: Array<{ label: string; row: ModeledResetRow }> = [];
    const cut = (label: string): void => {
      observations.push({ label, row: classifyModeledZeroRefTree(tree.powerCut()) });
    };

    cut("before-P0");
    publish(tree, "state/reset-v1.json", "prepared"); cut("after-P0");

    tree.write("state/reset-candidates/.rbox-tmp-7-1-id.db", "N");
    tree.fsyncFile("state/reset-candidates/.rbox-tmp-7-1-id.db"); cut("before-candidate-rename");
    tree.rename("state/reset-candidates/.rbox-tmp-7-1-id.db", "state/reset-candidates/id.db");
    tree.fsyncDir("state/reset-candidates"); cut("after-candidate-parent-fsync");

    tree.write("state/lineages/nonce/.rbox-tmp-7-1-old.db", "O");
    tree.fsyncFile("state/lineages/nonce/.rbox-tmp-7-1-old.db"); cut("before-archive-rename");
    tree.rename("state/lineages/nonce/.rbox-tmp-7-1-old.db", "state/lineages/nonce/old.db");
    tree.fsyncDir("state/lineages/nonce"); cut("after-archive-parent-fsync");

    publish(tree, "state/reset-v1.json", "ready"); cut("after-ready");
    tree.rename("state/reset-candidates/id.db", "state/state.db");
    tree.fsyncDir("state"); cut("after-destination-parent-fsync");
    tree.fsyncDir("state/reset-candidates"); cut("after-source-parent-fsync");

    publish(tree, "state/reset-v1.json", "installed"); cut("after-installed");
    cut("after-state-check");
    publish(tree, "state/state-incarnation.json", "MN"); cut("after-marker-write");
    publish(tree, "state/reset-v1.json", "z-retired"); cut("after-z-retired");
    tree.unlink("state/reset-v1.json"); cut("before-journal-parent-fsync");
    tree.fsyncDir("state"); cut("after-journal-parent-fsync");

    expect(observations).toEqual([
      { label: "before-P0", row: "halt" },
      { label: "after-P0", row: "P0" },
      { label: "before-candidate-rename", row: "P0" },
      { label: "after-candidate-parent-fsync", row: "P1" },
      { label: "before-archive-rename", row: "P1" },
      { label: "after-archive-parent-fsync", row: "P2" },
      { label: "after-ready", row: "R0" },
      { label: "after-destination-parent-fsync", row: "R2" },
      { label: "after-source-parent-fsync", row: "R1" },
      { label: "after-installed", row: "I0" },
      { label: "after-state-check", row: "I0" },
      { label: "after-marker-write", row: "I2" },
      { label: "after-z-retired", row: "Z0" },
      { label: "before-journal-parent-fsync", row: "Z0" },
      { label: "after-journal-parent-fsync", row: "steady" },
    ]);
  });

  test("COMMITTED and backup publication expose only absent-or-exact power images", () => {
    const tree = new DurableTree();
    tree.seed("state/quarantine/bundle/manifest.json", "manifest");
    tree.write("state/quarantine/bundle/.rbox-tmp-7-1-COMMITTED", "commit");
    tree.fsyncFile("state/quarantine/bundle/.rbox-tmp-7-1-COMMITTED");
    expect(tree.powerCut()["state/quarantine/bundle/COMMITTED"]).toBeUndefined();
    tree.rename("state/quarantine/bundle/.rbox-tmp-7-1-COMMITTED", "state/quarantine/bundle/COMMITTED");
    expect(tree.powerCut()["state/quarantine/bundle/COMMITTED"]).toBeUndefined();
    tree.fsyncDir("state/quarantine/bundle");
    expect(Buffer.from(tree.powerCut()["state/quarantine/bundle/COMMITTED"]!, "hex").toString()).toBe("commit");

    tree.write("state/backups/.rbox-tmp-7-1-snapshot.db", "BACKUP");
    tree.fsyncFile("state/backups/.rbox-tmp-7-1-snapshot.db");
    tree.rename("state/backups/.rbox-tmp-7-1-snapshot.db", "state/backups/snapshot.db");
    expect(tree.powerCut()["state/backups/snapshot.db"]).toBeUndefined();
    tree.fsyncDir("state/backups");
    expect(Buffer.from(tree.powerCut()["state/backups/snapshot.db"]!, "hex").toString()).toBe("BACKUP");
  });

  test("every configured Rk and Ag boundary is a single global durable prefix", () => {
    const tree = new DurableTree();
    tree.seed("state/state.db", "O");
    tree.seed("state/reset-v1.json", "prepared");
    tree.seed("state/reset-candidates/id.db", "N");
    tree.seed("state/lineages/nonce/old.db", "O");
    tree.seed("meta/z-count", "2");
    tree.seed("meta/group-count", "2");
    tree.seed("refs/active/1", "target");
    tree.seed("refs/active/2", "target");
    expect(classifyModeledZeroRefTree(tree.powerCut())).toBe("P2");
    tree.seed("refs/recovery/1", "target");
    expect(classifyModeledZeroRefTree(tree.powerCut())).toBe("P3.1");
    tree.seed("refs/recovery/2", "target");
    expect(classifyModeledZeroRefTree(tree.powerCut())).toBe("P3.2");
    publish(tree, "state/reset-v1.json", "ready");
    expect(classifyModeledZeroRefTree(tree.powerCut())).toBe("R0");

    tree.rename("state/reset-candidates/id.db", "state/state.db");
    tree.fsyncDir("state");
    tree.fsyncDir("state/reset-candidates");
    publish(tree, "state/reset-v1.json", "installed");
    publish(tree, "state/state-incarnation.json", "MN");
    expect(classifyModeledZeroRefTree(tree.powerCut())).toBe("I2");
    tree.unlink("refs/active/1"); tree.fsyncDir("refs/active");
    expect(classifyModeledZeroRefTree(tree.powerCut())).toBe("I3.1");
    tree.unlink("refs/active/2"); tree.fsyncDir("refs/active");
    expect(classifyModeledZeroRefTree(tree.powerCut())).toBe("I3.2");
    publish(tree, "state/reset-v1.json", "z-retired");
    expect(classifyModeledZeroRefTree(tree.powerCut())).toBe("Z0");
  });

  test("W1 checkpoint power cut keeps WAL takeover or reaches exact S0", () => {
    const tree = new DurableTree();
    tree.seed("state/state.db", "OLD-CHECKPOINT");
    tree.seed("state/state.db-wal", "COMMITTED-WAL");
    tree.seed("state/state.db-shm", "SHM");
    tree.write("state/state.db", "CHECKPOINTED");
    tree.fsyncFile("state/state.db");
    tree.unlink("state/state.db-wal");
    tree.unlink("state/state.db-shm");
    const beforeParentFsync = tree.powerCut();
    expect(Buffer.from(beforeParentFsync["state/state.db"]!, "hex").toString()).toBe("CHECKPOINTED");
    expect(beforeParentFsync["state/state.db-wal"]).toBeDefined();
    expect(beforeParentFsync["state/state.db-shm"]).toBeDefined();
    tree.fsyncDir("state");
    const afterParentFsync = tree.powerCut();
    expect(Buffer.from(afterParentFsync["state/state.db"]!, "hex").toString()).toBe("CHECKPOINTED");
    expect(afterParentFsync["state/state.db-wal"]).toBeUndefined();
    expect(afterParentFsync["state/state.db-shm"]).toBeUndefined();
  });
});
