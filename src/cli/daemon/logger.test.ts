import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { guardDaemonCrashLog } from "../daemon-control.js";
import { daemonCrashLogPath, daemonDatedLogPath, daemonRuntimeDir } from "../rbox-paths.js";
import { parseDaemonDatedLogBasename, parseDaemonLogRetentionDays, RotatingDaemonLogger } from "./logger.js";

let root: string;
let home: string;
let savedRboxHome: string | undefined;

beforeEach(async () => {
  savedRboxHome = process.env.RBOX_HOME;
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-logger-"));
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-logger-home-"));
  process.env.RBOX_HOME = home;
});

afterEach(async () => {
  if (savedRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = savedRboxHome;
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(home, { recursive: true, force: true });
});

test("one captured Date selects both the ISO timestamp and UTC basename", async () => {
  let calls = 0;
  const at = new Date("2026-07-15T23:59:59.999Z");
  const logger = new RotatingDaemonLogger(root, () => { calls++; return at; }, fs, { bootId: "one", pid: 41 });
  logger.log("record");
  logger.close();
  expect(calls).toBe(1);
  expect(await fsp.readFile(daemonDatedLogPath(root, at), "utf8")).toBe("2026-07-15T23:59:59.999Z record\n");
  expect(await fsp.readFile(daemonCrashLogPath(root), "utf8")).toContain("logs: basename=daemon-2026-07-15.log bootId=one pid=41");
});

test("rollover closes old before opening new and publishes a pointer on every open", async () => {
  const dates = [new Date("2026-07-15T23:59:59.999Z"), new Date("2026-07-16T00:00:00.000Z")];
  const logger = new RotatingDaemonLogger(root, () => dates.shift()!, fs, { bootId: "roll", pid: 42 });
  logger.log("final-old");
  logger.log("first-new");
  logger.close();
  expect(await fsp.readFile(daemonDatedLogPath(root, new Date("2026-07-15T00:00:00Z")), "utf8")).toContain("final-old");
  expect(await fsp.readFile(daemonDatedLogPath(root, new Date("2026-07-16T00:00:00Z")), "utf8")).toContain("first-new");
  expect((await fsp.readFile(daemonCrashLogPath(root), "utf8")).match(/logs: basename=/g)).toHaveLength(2);
});

test("short writes complete the encoded record and close is idempotent", async () => {
  const writes: Buffer[] = [];
  const io = {
    ...fs,
    writeSync(fd: number, buffer: Uint8Array, offset?: number, length?: number): number {
      const start = offset ?? 0;
      const count = Math.min(length ?? buffer.byteLength, 3);
      writes.push(Buffer.from(buffer).subarray(start, start + count));
      return count;
    },
  };
  const logger = new RotatingDaemonLogger(root, () => new Date("2026-07-15T12:00:00Z"), io, { bootId: "short" });
  logger.log("short-write-record");
  logger.close();
  logger.close();
  expect(Buffer.concat(writes).toString("utf8")).toContain("short-write-record\n");
});

test("simultaneous synchronous calls remain complete and ordered", async () => {
  let tick = 0;
  const logger = new RotatingDaemonLogger(root, () => new Date(Date.UTC(2026, 6, 15, 12, 0, 0, tick++)), fs, { bootId: "concurrent" });
  await Promise.all(Array.from({ length: 100 }, (_, index) => Promise.resolve().then(() => logger.log(`record=${index}`))));
  logger.close();
  const lines = (await fsp.readFile(daemonDatedLogPath(root, new Date("2026-07-15T12:00:00Z")), "utf8")).trim().split("\n");
  expect(lines).toHaveLength(100);
  expect(lines.map((line) => Number(/record=(\d+)$/.exec(line)![1]))).toEqual(Array.from({ length: 100 }, (_, index) => index));
});

test("a primary write failure falls back to the crash fd without throwing", () => {
  const crash: Buffer[] = [];
  let nextFd = 10;
  const io = {
    ...fs,
    mkdirSync() {},
    openSync() { return nextFd++; },
    writeSync(fd: number, bytes: Uint8Array, offset = 0, length = bytes.byteLength): number {
      if (fd === 11) throw Object.assign(new Error("primary failed"), { code: "EIO" });
      crash.push(Buffer.from(bytes).subarray(offset, offset + length));
      return length;
    },
    closeSync() {},
    readdirSync() { return []; },
  };
  const logger = new RotatingDaemonLogger(root, () => new Date("2026-07-15T12:00:00Z"), io, { bootId: "fallback" });
  expect(() => logger.log("fallback-record")).not.toThrow();
  logger.close();
  expect(Buffer.concat(crash).toString("utf8")).toContain("fallback-record");
});

test("an initial dated-open failure writes a diagnostic to the crash fd", () => {
  const crash: Buffer[] = [];
  const io = {
    ...fs,
    mkdirSync() {},
    openSync(file: fs.PathLike): number {
      if (String(file).includes("daemon-2026-07-15.log")) throw Object.assign(new Error("open failed"), { code: "EACCES" });
      return 10;
    },
    writeSync(_fd: number, bytes: Uint8Array, offset = 0, length = bytes.byteLength): number {
      crash.push(Buffer.from(bytes).subarray(offset, offset + length));
      return length;
    },
    closeSync() {},
  };
  const logger = new RotatingDaemonLogger(root, () => new Date("2026-07-15T12:00:00Z"), io, { bootId: "open-fail" });
  logger.log("record");
  logger.close();
  const text = Buffer.concat(crash).toString("utf8");
  expect(text).toContain("log open failed: basename=daemon-2026-07-15.log code=EACCES");
  expect(text).toContain("record");
  expect(text).not.toContain("logs: basename=");
});

test("primary and crash failures emit exactly one non-recursive self-report", () => {
  const reports: Buffer[] = [];
  const io = {
    ...fs,
    openSync(): number { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); },
    writeSync(fd: number, bytes: Uint8Array, offset?: number, length?: number): number {
      if (fd !== 2) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      const start = offset ?? 0;
      const count = length ?? bytes.byteLength;
      reports.push(Buffer.from(bytes).subarray(start, start + count));
      return count;
    },
  };
  const logger = new RotatingDaemonLogger(root, () => new Date("2026-07-15T12:00:00Z"), io, { bootId: "fail" });
  expect(() => { logger.log("one"); logger.log("two"); logger.close(); }).not.toThrow();
  expect(Buffer.concat(reports).toString("utf8")).toBe("2026-07-15T12:00:00.000Z log failure: dated and crash sinks unavailable\n");
});

test("failed crash-fd warning and pointer writes share the at-most-once self-report", () => {
  const reports: Buffer[] = [];
  let nextFd = 10;
  const io = {
    ...fs,
    openSync(): number { return nextFd++; },
    writeSync(fd: number, bytes: Uint8Array, offset?: number, length?: number): number {
      const start = offset ?? 0;
      const count = length ?? bytes.byteLength;
      if (fd === 2) { reports.push(Buffer.from(bytes).subarray(start, start + count)); return count; }
      if (fd === 10) throw Object.assign(new Error("crash full"), { code: "ENOSPC" });
      return count;
    },
    closeSync(): void {},
    readdirSync(): string[] { return []; },
  };
  const logger = new RotatingDaemonLogger(root, () => new Date("2026-07-15T12:00:00Z"), io, { bootId: "fail", retention: "invalid" });
  logger.log("opens-dated-and-publishes-pointer");
  logger.close();
  expect(Buffer.concat(reports).toString("utf8")).toBe("2026-07-15T12:00:00.000Z log failure: dated and crash sinks unavailable\n");
});

test("boot record and unlink-while-open recovery land in a recreated dated file", async () => {
  let now = new Date("2026-07-15T12:00:00Z");
  const logger = new RotatingDaemonLogger(root, () => now, fs, { bootId: "unlink", pid: 43 });
  logger.boot();
  const dated = daemonDatedLogPath(root, now);
  await fsp.unlink(dated);
  now = new Date(now.getTime() + 61_000);
  logger.log("after-unlink");
  logger.close();
  expect(await fsp.readFile(dated, "utf8")).toContain("after-unlink");
  expect(await fsp.readFile(daemonCrashLogPath(root), "utf8")).toContain("bootId=unlink pid=43");
});

test("retention parser is strict, positive, safe, and clamped", () => {
  expect(parseDaemonLogRetentionDays(undefined)).toEqual({ days: 14 });
  for (const invalid of ["", "0", "-1", "+1", " 1", "1 ", "1.5", "wat", "Infinity", "9007199254740992"]) {
    expect(parseDaemonLogRetentionDays(invalid).days).toBe(14);
    expect(parseDaemonLogRetentionDays(invalid).warning).toBeDefined();
  }
  expect(parseDaemonLogRetentionDays("1")).toEqual({ days: 1 });
  expect(parseDaemonLogRetentionDays("99999")).toEqual({ days: 3650 });
});

test("dated names reject junk and impossible dates", () => {
  expect(parseDaemonDatedLogBasename("daemon-2026-07-15.log")).toBeDefined();
  for (const name of ["xdaemon-2026-07-15.log", "daemon-2026-02-30.log", "daemon-2026-13-01.log", "daemon-2026-7-1.log", "daemon-2026-07-15.log.old"]) {
    expect(parseDaemonDatedLogBasename(name)).toBeUndefined();
  }
});

test("retention uses filename dates, ignores mtime/future/junk/symlinks, and protects current", async () => {
  const runtime = daemonRuntimeDir(root);
  await fsp.mkdir(runtime, { recursive: true });
  const old = path.join(runtime, "daemon-2026-07-01.log");
  const future = path.join(runtime, "daemon-2026-08-01.log");
  const junk = path.join(runtime, "daemon-nope.log");
  await Promise.all([fsp.writeFile(old, "old"), fsp.writeFile(future, "future"), fsp.writeFile(junk, "junk")]);
  await fsp.utimes(old, new Date("2030-01-01"), new Date("2030-01-01"));
  await fsp.utimes(future, new Date("2000-01-01"), new Date("2000-01-01"));
  await fsp.symlink(old, path.join(runtime, "daemon-2026-06-01.log"));
  await fsp.mkdir(path.join(runtime, "daemon-2026-05-01.log"));
  const now = new Date("2026-07-15T12:00:00Z");
  const logger = new RotatingDaemonLogger(root, () => now, fs, { retention: "14" });
  logger.log("current");
  logger.close();
  expect(await fsp.stat(old).catch(() => undefined)).toBeUndefined();
  expect(await fsp.readFile(future, "utf8")).toBe("future");
  expect(await fsp.readFile(junk, "utf8")).toBe("junk");
  expect((await fsp.lstat(path.join(runtime, "daemon-2026-06-01.log"))).isSymbolicLink()).toBe(true);
  expect((await fsp.lstat(path.join(runtime, "daemon-2026-05-01.log"))).isDirectory()).toBe(true);
  expect(await fsp.readFile(daemonDatedLogPath(root, now), "utf8")).toContain("current");
});

test("crash sink startup guard keeps exactly one old generation above 5 MB", async () => {
  const crash = daemonCrashLogPath(root);
  await fsp.mkdir(path.dirname(crash), { recursive: true });
  await fsp.writeFile(`${crash}.old`, "older");
  const handle = await fsp.open(crash, "w");
  await handle.truncate(5_000_001);
  await handle.close();
  guardDaemonCrashLog(root);
  expect((await fsp.stat(`${crash}.old`)).size).toBe(5_000_001);
  expect(await fsp.stat(crash).catch(() => undefined)).toBeUndefined();
});

test("crash sink guard preserves the retained generation across two launchers", async () => {
  const crash = daemonCrashLogPath(root);
  await fsp.mkdir(path.dirname(crash), { recursive: true });
  const handle = await fsp.open(crash, "w");
  await handle.truncate(5_000_001);
  await handle.close();
  const module = path.resolve("src/cli/daemon-control.ts");
  const script = `import { guardDaemonCrashLog } from ${JSON.stringify(module)}; guardDaemonCrashLog(process.env.ROOT);`;
  const launch = () => Bun.spawn([process.execPath, "-e", script], { cwd: process.cwd(), env: { ...process.env, RBOX_HOME: home, ROOT: root }, stdout: "pipe", stderr: "pipe" });
  const children = [launch(), launch()];
  expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
  expect((await fsp.stat(`${crash}.old`)).size).toBe(5_000_001);
});

test("crash sink guard diagnoses non-ENOENT rename failures", async () => {
  const crash = daemonCrashLogPath(root);
  await fsp.mkdir(path.dirname(crash), { recursive: true });
  const handle = await fsp.open(crash, "w");
  await handle.truncate(5_000_001);
  await handle.close();
  await fsp.mkdir(`${crash}.old`);
  const lines: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    guardDaemonCrashLog(root);
  } finally {
    process.stderr.write = originalWrite;
  }
  expect(lines.join("")).toContain("rbox: crash-log guard failed:");
  expect((await fsp.stat(crash)).size).toBe(5_000_001);
});

test("two real processes append intact records across rollover and concurrent prune", async () => {
  const runtime = daemonRuntimeDir(root);
  await fsp.mkdir(runtime, { recursive: true });
  await fsp.writeFile(path.join(runtime, "daemon-2026-06-01.log"), "old\n");
  const module = path.resolve("src/cli/daemon/logger.ts");
  const script = `
    import fs from "node:fs";
    import { RotatingDaemonLogger } from ${JSON.stringify(module)};
    const root = process.env.ROOT;
    const id = process.env.ID;
    let n = 0;
    const logger = new RotatingDaemonLogger(root, () => new Date(n++ < 51 ? "2026-07-15T23:59:59.999Z" : "2026-07-16T00:00:00.000Z"), fs, { bootId: id, retention: "2" });
    logger.boot();
    for (let i = 0; i < 100; i++) logger.log(id + " record=" + i);
    logger.close();
  `;
  const spawn = (id: string) => Bun.spawn([process.execPath, "-e", script], { cwd: process.cwd(), env: { ...process.env, RBOX_HOME: home, ROOT: root, ID: id }, stdout: "pipe", stderr: "pipe" });
  const children = [spawn("alpha"), spawn("beta")];
  expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
  const [oldDay, newDay] = await Promise.all([
    fsp.readFile(path.join(runtime, "daemon-2026-07-15.log"), "utf8"),
    fsp.readFile(path.join(runtime, "daemon-2026-07-16.log"), "utf8"),
  ]);
  const combined = oldDay + newDay;
  const records = combined.split("\n").filter((line) => / (?:alpha|beta) record=/.test(line));
  expect(records).toHaveLength(200);
  expect(records.every((line) => /^2026-07-1[56]T\S+ (?:alpha|beta) record=\d+$/.test(line))).toBe(true);
  const payloads = records.map((line) => line.replace(/^\S+ /, ""));
  const expectedPayloads = ["alpha", "beta"].flatMap((id) => Array.from({ length: 100 }, (_, i) => `${id} record=${i}`));
  expect(new Set(payloads)).toEqual(new Set(expectedPayloads));
  const crash = await fsp.readFile(daemonCrashLogPath(root), "utf8");
  expect(crash).toContain("bootId=alpha");
  expect(crash).toContain("bootId=beta");
  expect(new Set([...crash.matchAll(/pid=(\d+)/g)].map((match) => match[1])).size).toBe(2);
  for (const id of ["alpha", "beta"]) {
    expect(oldDay).toContain(`${id} record=49`);
    expect(newDay).toContain(`${id} record=50`);
  }
  expect((await fsp.readdir(runtime)).filter((name) => /^daemon-\d{4}-\d{2}-\d{2}\.log\./.test(name))).toEqual([]);
  expect(await fsp.stat(path.join(runtime, "daemon-2026-06-01.log")).catch(() => undefined)).toBeUndefined();
});
