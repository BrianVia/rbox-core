import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LOG_LINES, daemonRuntimeDir, logsDaemon, workspaceKey } from "./daemon-control.js";

let root: string;
let home: string;
let out: string[];
const origWrite = process.stdout.write.bind(process.stdout);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-logs-"));
  // Redirect the global ~/.rbox to a throwaway dir so the daemon's runtime files
  // land somewhere we can inspect and clean up (RBOX_HOME is the shared override).
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-home-"));
  process.env.RBOX_HOME = home;
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  out = [];
  // Capture stdout writes from the native tail (it uses process.stdout.write directly).
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
});
afterEach(async () => {
  process.stdout.write = origWrite;
  delete process.env.RBOX_HOME;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

const logFile = () => path.join(daemonRuntimeDir(root), "daemon.log");
const writeLog = async (n: number) => {
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(logFile(), Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
};

test("missing log file prints a friendly hint, not an error", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...m: unknown[]) => void logs.push(m.map(String).join(" "));
  try {
    await logsDaemon(root, { follow: false, lines: DEFAULT_LOG_LINES });
  } finally {
    console.log = origLog;
  }
  expect(logs.join("\n")).toContain("no daemon log yet");
});

test("tails the last N lines, not the whole file", async () => {
  await writeLog(1000);
  await logsDaemon(root, { follow: false, lines: 10 });
  const printed = out.join("");
  const lines = printed.split("\n").filter(Boolean);
  expect(lines).toHaveLength(10);
  expect(lines[0]).toBe("line 991");
  expect(lines[9]).toBe("line 1000");
});

test("prints the whole file when it has fewer lines than requested", async () => {
  await writeLog(3);
  await logsDaemon(root, { follow: false, lines: DEFAULT_LOG_LINES });
  expect(out.join("").split("\n").filter(Boolean)).toEqual(["line 1", "line 2", "line 3"]);
});

test("lines spanning the backward-read chunk boundary are tailed correctly", async () => {
  // Each line ~100 bytes × 2000 ≫ the 64 KiB read chunk, forcing multiple seeks.
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  const big = Array.from({ length: 2000 }, (_, i) => `${i + 1} ` + "x".repeat(100)).join("\n") + "\n";
  await fs.writeFile(logFile(), big);
  await logsDaemon(root, { follow: false, lines: 5 });
  const lines = out.join("").split("\n").filter(Boolean);
  expect(lines).toHaveLength(5);
  expect(lines[0].startsWith("1996 ")).toBe(true);
  expect(lines[4].startsWith("2000 ")).toBe(true);
});

test("empty log file produces no output and does not throw", async () => {
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(logFile(), "");
  await logsDaemon(root, { follow: false, lines: 10 });
  expect(out.join("")).toBe("");
});

test("the runtime dir is global (under ~/.rbox), not inside the workspace", () => {
  const dir = daemonRuntimeDir(root);
  expect(dir.startsWith(path.join(home, ".rbox"))).toBe(true);
  expect(dir.startsWith(root)).toBe(false);
});

test("the workspace key is deterministic from the resolved root", () => {
  expect(workspaceKey(root)).toBe(workspaceKey(root));
  // A trailing slash / non-normalized form resolves to the same key.
  expect(workspaceKey(root + "/")).toBe(workspaceKey(root));
});

test("distinct roots get distinct runtime dirs (hash disambiguates same basename)", () => {
  const a = "/tmp/alpha/project";
  const b = "/tmp/beta/project"; // same basename, different path
  expect(workspaceKey(a)).not.toBe(workspaceKey(b));
  expect(daemonRuntimeDir(a)).not.toBe(daemonRuntimeDir(b));
  // Human-scannable: the basename is embedded in the key.
  expect(workspaceKey(a).startsWith("project-")).toBe(true);
});

test("falls back to the legacy in-workspace log when no global log exists", async () => {
  // Simulate a daemon started before the move: only the old location has a log.
  await fs.writeFile(path.join(root, ".rbox", "daemon.log"), "old-line\n");
  await logsDaemon(root, { follow: false, lines: 10 });
  expect(out.join("")).toContain("old-line");
});
