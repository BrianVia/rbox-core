import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "./config.js";
import { main } from "./main-dispatch.js";
import { resetJournalDoctorCmd, withResetJournalDoctorFence } from "./reset-journal-doctor.js";
import { resetJournalPath } from "./reset-journal.js";
import { resetQuarantineRoot } from "./reset-quarantine.js";
import { setProtocolLockTraceForTests, type ProtocolLockTraceEvent } from "../cli/sync-git/protocol-locks.js";
import { inspectResetJournalSafety } from "./reset-halt-inspection.js";
import crypto from "node:crypto";
import { authorityMarkerBytes } from "./state-plane/authority-marker.js";
import { sqliteResetPaths, statePath } from "./state-plane/paths.js";
import { createStateStore } from "./state-plane/store/open.js";

let root = "";
let cfg: WorkspaceConfig;
const oldArgv = process.argv;
const oldCwd = process.cwd();

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-doctor-"));
  cfg = {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws-doctor",
    projectId: "root",
    deviceId: "dev-doctor",
    rootPath: root,
    remoteUrl: "https://api.invalid",
    token: "",
    encrypted: true,
  };
  await saveConfig(root, cfg);
});

afterEach(async () => {
  process.argv = oldArgv;
  process.chdir(oldCwd);
  await fs.rm(root, { recursive: true, force: true });
});

async function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
  try { await fn(); } finally { console.log = oldLog; }
  return lines.join("\n");
}

test("doctor reset-journal dispatches before ordinary loadState collection", async () => {
  await fs.mkdir(path.dirname(resetJournalPath(root)), { recursive: true });
  await fs.writeFile(resetJournalPath(root), "{malformed");
  process.argv = [process.execPath, "rbox", "doctor", "reset-journal", root];
  process.chdir(root);
  const output = await capture(() => main());
  expect(output).toContain("malformed reset journal JSON");
  expect(output).toContain("Files on disk are untouched");
});

test("oversized and nesting-limit halts preserve the legacy diagnostic contract", async () => {
  await fs.mkdir(path.dirname(resetJournalPath(root)), { recursive: true });
  const oversized = Buffer.alloc(512 * 1024 + 1, 0x20);
  await fs.writeFile(resetJournalPath(root), oversized);
  const oversizedInspection = await inspectResetJournalSafety(root);
  expect(oversizedInspection).toMatchObject({
    status: "halt",
    journalIdentityHash: crypto.createHash("sha256").update(oversized).digest("hex"),
  });

  const nested = `${"[".repeat(80)}0${"]".repeat(80)}`;
  await fs.writeFile(resetJournalPath(root), nested);
  expect(await inspectResetJournalSafety(root)).toMatchObject({
    status: "halt",
    reason: "reset-corruption: malformed reset journal JSON (nesting limit)",
  });
});

test("malformed journal quarantine is bounded to the journal", async () => {
  const journal = resetJournalPath(root);
  const candidate = path.join(root, ".rbox", "state", "reset-candidates", "unknown.json");
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  await fs.writeFile(journal, "{malformed");
  await fs.writeFile(candidate, "do not infer me");
  const output = await capture(() => resetJournalDoctorCmd(root, { quarantine: true }));
  expect(output).toContain("candidate/archive artifacts were left untouched");
  expect(await fs.lstat(journal).catch(() => undefined)).toBeUndefined();
  expect(await fs.readFile(candidate, "utf8")).toBe("do not infer me");
  expect((await fs.readdir(resetQuarantineRoot(root))).length).toBe(1);
});

test("legacy journal quarantine restores only for an eligible durable config", async () => {
  const stream = syncStreamId(cfg);
  await fs.mkdir(path.dirname(resetJournalPath(root)), { recursive: true });
  await fs.writeFile(resetJournalPath(root), JSON.stringify({ v: 1, old: { stream }, next: { stream: "next-stream" } }));
  await resetJournalDoctorCmd(root, { quarantine: true });
  const [id] = await fs.readdir(resetQuarantineRoot(root));
  expect(id).toBeDefined();
  const output = await capture(() => resetJournalDoctorCmd(root, { restore: id }));
  expect(output).toContain("reset journal restored");
  expect(JSON.parse(await fs.readFile(resetJournalPath(root), "utf8"))).toMatchObject({ v: 1 });
});

test("quarantine and restore use the complete repository-order fence", async () => {
  const commonDir = path.join(root, "fake-common");
  await fs.mkdir(commonDir, { recursive: true });
  for (const operation of ["quarantine", "restore"] as const) {
    const trace: ProtocolLockTraceEvent[] = [];
    setProtocolLockTraceForTests((event) => trace.push(event));
    try {
      await withResetJournalDoctorFence(root, [{
        commonDir,
        reflogRefs: ["refs/rbox-local/base-absent-settled/v1/" + "a".repeat(64)],
        origins: true,
      }], async () => {});
    } finally {
      setProtocolLockTraceForTests(undefined);
    }
    const acquired = trace.filter((event) => event.action === "acquire").map((event) => event.class);
    expect(acquired).toEqual(["operation", "reflog", "origin", "git", "reservation", "orig-head", "index", "state"]);
    expect(operation).toMatch(/quarantine|restore/);
  }
});

test("doctor reports no standing reset through a real selected SQLite authority", async () => {
  const authorityId = "a".repeat(32);
  await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  createStateStore(sqliteResetPaths.active(root), {
    authorityId,
    lineageId: "b".repeat(32),
    stream: syncStreamId(cfg),
    createdBy: "test",
    stateNonce: "c".repeat(32),
    stateRevision: 0,
  }).close();
  await fs.writeFile(statePath(root), authorityMarkerBytes(authorityId));

  expect(await capture(() => resetJournalDoctorCmd(root))).toBe("reset journal: none");
});
