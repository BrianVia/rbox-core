/**
 * Probe: enumerate every `node:fs` mutation a full M0->M7 migration performs,
 * grouped by the phase that was live when it happened.
 *
 * Not a test. This is how 5C's kill points were derived rather than guessed:
 * the machine reports its own durable transitions and physical effects, and the
 * matrix is built from that list.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../../src/cli/workspace-config.js";
import { saveStateUnsafeLegacyOrTest } from "../../src/cli/sync-state-store.js";
import { sqliteResetPaths } from "../../src/cli/state-plane/paths.js";
import { withStatePlaneLocks } from "../../src/cli/state-plane/locks.js";
import { runMigration } from "../../src/cli/state-plane/migration/authority.js";

const MUTATORS = [
  "writeFileSync", "writeSync", "renameSync", "unlinkSync", "mkdirSync", "rmSync",
  "openSync", "closeSync", "fsyncSync", "ftruncateSync", "copyFileSync", "linkSync",
  "appendFileSync", "truncateSync", "chmodSync",
] as const;
type MutatorName = typeof MUTATORS[number];
type MutableFsTable = Partial<Record<MutatorName, (...args: unknown[]) => unknown>>;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "u3-5c-probe-home-"));
process.env.RBOX_HOME = home;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "u3-5c-probe-ws-"));
const config: WorkspaceConfig = {
  schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev",
  rootPath: root, remoteUrl: "https://example.invalid", token: "",
};
await saveConfig(root, config);
fs.mkdirSync(sqliteResetPaths.stateRoot(root), { recursive: true });
const files = Array.from({ length: 200 }, (_, i) => ({
  path: `repo${i % 7}/file-${i}.txt`,
  sha256: crypto.createHash("sha256").update(`f${i}`).digest("hex"),
  size: 100 + i,
  mode: 0o644,
  mtimeMs: 1_700_000_000_000 + i,
  type: "file" as const,
}));
await saveStateUnsafeLegacyOrTest(root, {
  stream: syncStreamId(config),
  lastSyncedSequence: 0,
  lastSyncedManifest: { generatedAt: "", files },
} as never);

const log: { phase: string; syscall: string; args: string }[] = [];
let phase = "start";
const table = fs as unknown as MutableFsTable;
const originals = new Map<MutatorName, (...args: unknown[]) => unknown>();
for (const name of MUTATORS) {
  const original = table[name];
  if (typeof original !== "function") continue;
  originals.set(name, original);
  const call = original;
  table[name] = function traced(this: unknown, ...args: unknown[]): unknown {
    const strings = args.filter((a) => typeof a === "string") as string[];
    const rel = strings.map((s) => s.replaceAll(root, "<ws>")).join(" ");
    if (rel.includes("<ws>")) log.push({ phase, syscall: name, args: rel });
    return call.apply(this, args);
  };
}

const outcome = await withStatePlaneLocks(root, (locks) =>
  runMigration(root, { entry: "foreground-migrate", locks }, (p) => {
    phase = `${p.phase}:${p.step}`;
  }));

for (const [name, original] of originals) table[name] = original;

console.log("outcome:", JSON.stringify(outcome, null, 2).slice(0, 400));
console.log(`\n${log.length} workspace-touching fs mutations\n`);
const byPhase = new Map<string, { syscall: string; args: string }[]>();
for (const entry of log) {
  const list = byPhase.get(entry.phase) ?? [];
  list.push({ syscall: entry.syscall, args: entry.args });
  byPhase.set(entry.phase, list);
}
for (const [key, entries] of byPhase) {
  console.log(`### ${key}  (${entries.length})`);
  const counts = new Map<string, number>();
  for (const e of entries) {
    const k = `${e.syscall}  ${e.args}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [k, n] of counts) console.log(`  ${n > 1 ? `${n}x ` : ""}${k}`);
  console.log();
}
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
