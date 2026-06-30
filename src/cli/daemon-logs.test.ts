import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LOG_LINES, logsDaemon } from "./daemon-control.js";

let root: string;
let out: string[];
const origWrite = process.stdout.write.bind(process.stdout);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-logs-"));
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
  await fs.rm(root, { recursive: true, force: true });
});

const logFile = () => path.join(root, ".rbox", "daemon.log");
const writeLog = (n: number) =>
  fs.writeFile(logFile(), Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n");

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
  const big = Array.from({ length: 2000 }, (_, i) => `${i + 1} ` + "x".repeat(100)).join("\n") + "\n";
  await fs.writeFile(logFile(), big);
  await logsDaemon(root, { follow: false, lines: 5 });
  const lines = out.join("").split("\n").filter(Boolean);
  expect(lines).toHaveLength(5);
  expect(lines[0].startsWith("1996 ")).toBe(true);
  expect(lines[4].startsWith("2000 ")).toBe(true);
});

test("empty log file produces no output and does not throw", async () => {
  await fs.writeFile(logFile(), "");
  await logsDaemon(root, { follow: false, lines: 10 });
  expect(out.join("")).toBe("");
});
