import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LOG_LINES, daemonRuntimeDir, logsDaemon, resolveDaemonLogSources, workspaceKey } from "./daemon-control.js";
import { daemonCrashLogPath, daemonDatedLogPath } from "./rbox-paths.js";

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

const logFile = () => daemonDatedLogPath(root, new Date());
const writeLog = async (n: number) => {
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(logFile(), Array.from({ length: n }, (_, i) => `2026-07-15T12:00:00.000Z line ${i + 1}`).join("\n") + "\n");
};

function controlledPolls(): {
  waitForPoll: () => Promise<void>;
  waitUntilPoll: () => Promise<void>;
  release: () => void;
} {
  const releases: Array<() => void> = [];
  const arrivals: Array<() => void> = [];
  return {
    waitForPoll: () => new Promise<void>((resolve) => {
      releases.push(resolve);
      arrivals.shift()?.();
    }),
    waitUntilPoll: async () => {
      if (releases.length === 0) await new Promise<void>((resolve) => arrivals.push(resolve));
    },
    release: () => releases.shift()!(),
  };
}

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
  expect(lines[0]).toEndWith("line 991");
  expect(lines[9]).toEndWith("line 1000");
});

test("prints the whole file when it has fewer lines than requested", async () => {
  await writeLog(3);
  await logsDaemon(root, { follow: false, lines: DEFAULT_LOG_LINES });
  expect(out.join("").split("\n").filter(Boolean).map((line) => line.replace(/^\S+ /, ""))).toEqual(["line 1", "line 2", "line 3"]);
});

test("lines spanning the backward-read chunk boundary are tailed correctly", async () => {
  // Each line ~100 bytes × 2000 ≫ the 64 KiB read chunk, forcing multiple seeks.
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  const big = Array.from({ length: 2000 }, (_, i) => `2026-07-15T12:00:00.000Z ${i + 1} ` + "x".repeat(100)).join("\n") + "\n";
  await fs.writeFile(logFile(), big);
  await logsDaemon(root, { follow: false, lines: 5 });
  const lines = out.join("").split("\n").filter(Boolean);
  expect(lines).toHaveLength(5);
  expect(lines[0]).toContain(" 1996 ");
  expect(lines[4]).toContain(" 2000 ");
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

test("resolver chooses the greatest calendar-valid non-future dated file and returns all channels", async () => {
  const runtime = daemonRuntimeDir(root);
  await fs.mkdir(runtime, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(runtime, "daemon-2026-07-14.log"), "older"),
    fs.writeFile(path.join(runtime, "daemon-2026-07-15.log"), "newest"),
    fs.writeFile(path.join(runtime, "daemon-2026-07-16.log"), "future"),
    fs.writeFile(path.join(runtime, "daemon-2026-02-30.log"), "impossible"),
    fs.writeFile(daemonCrashLogPath(root), "crash"),
    fs.writeFile(path.join(root, ".rbox", "daemon.log"), "legacy"),
  ]);
  const sources = await resolveDaemonLogSources(root, new Date("2026-07-15T12:00:00Z"));
  expect(sources.dated).toEndWith("daemon-2026-07-15.log");
  expect(sources.crash).toBe(daemonCrashLogPath(root));
  expect(sources.legacy).toBe(path.join(root, ".rbox", "daemon.log"));
});

test("default logs stably merges timestamped channels and marks non-ISO crash output", async () => {
  const runtime = daemonRuntimeDir(root);
  await fs.mkdir(runtime, { recursive: true });
  const today = new Date();
  await fs.writeFile(daemonCrashLogPath(root), "2026-07-15T12:00:00.000Z crash-first\npanic without timestamp\n");
  await fs.writeFile(daemonDatedLogPath(root, today), "2026-07-15T12:00:00.000Z dated-second\n2026-07-15T12:00:01.000Z dated-last\n");
  await fs.writeFile(path.join(root, ".rbox", "daemon.log"), "2026-07-15T12:00:00.000Z legacy-third\n");
  await logsDaemon(root, { follow: false, lines: 10 });
  const printed = out.join("");
  expect(printed.indexOf("crash-first")).toBeLessThan(printed.indexOf("dated-second"));
  expect(printed.indexOf("dated-second")).toBeLessThan(printed.indexOf("legacy-third"));
  expect(printed).toContain("--- crash (un-timestamped) ---\npanic without timestamp");
});

test("follow drains final-old before first-new across rollover and cleans signal handlers", async () => {
  const runtime = daemonRuntimeDir(root);
  await fs.mkdir(runtime, { recursive: true });
  const old = path.join(runtime, "daemon-2026-07-14.log");
  const next = path.join(runtime, "daemon-2026-07-15.log");
  await fs.writeFile(old, "2026-07-14T23:59:59.000Z initial-old\n");
  const beforeInt = process.listenerCount("SIGINT");
  const polls = controlledPolls();
  const follow = logsDaemon(root, { follow: true, lines: 10 }, { waitForPoll: polls.waitForPoll });
  await polls.waitUntilPoll();
  await fs.appendFile(old, "2026-07-14T23:59:59.500Z final-old\n");
  await fs.writeFile(next, "2026-07-15T00:00:00.000Z first-new\n");
  await fs.writeFile(daemonCrashLogPath(root), "panic-after-rollover\n");
  for (let i = 0; i < 4; i++) { polls.release(); await polls.waitUntilPoll(); }
  await fs.appendFile(old, "2026-07-15T00:00:00.500Z late-old-other-process\n");
  await fs.appendFile(daemonCrashLogPath(root), "runtime-after-rollover\n");
  polls.release();
  await polls.waitUntilPoll();
  process.emit("SIGINT");
  polls.release();
  await follow;
  const printed = out.join("");
  expect(printed).toContain("final-old");
  expect(printed).toContain("first-new");
  expect(printed).toContain("late-old-other-process");
  expect(printed).toContain("runtime-after-rollover");
  expect(printed.indexOf("final-old")).toBeLessThan(printed.indexOf("first-new"));
  expect(process.listenerCount("SIGINT")).toBe(beforeInt);
});

test("follow initial-tail handoff emits an append exactly once without a gap", async () => {
  await writeLog(1);
  const polls = controlledPolls();
  const follow = logsDaemon(root, { follow: true, lines: 10 }, { waitForPoll: polls.waitForPoll });
  await polls.waitUntilPoll();
  await fs.appendFile(logFile(), "2026-07-15T12:00:01.000Z during-handoff\n");
  polls.release();
  await polls.waitUntilPoll();
  process.emit("SIGINT");
  polls.release();
  await follow;
  const printed = out.join("");
  expect(printed.match(/line 1/g)).toHaveLength(1);
  expect(printed.match(/during-handoff/g)).toHaveLength(1);
  expect(printed.indexOf("line 1")).toBeLessThan(printed.indexOf("during-handoff"));
});

test("follow with no source waits and promotes crash-only to dated", async () => {
  const polls = controlledPolls();
  const follow = logsDaemon(root, { follow: true, lines: 10 }, { waitForPoll: polls.waitForPoll });
  await polls.waitUntilPoll();
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(daemonCrashLogPath(root), "crash-only\n");
  polls.release();
  await polls.waitUntilPoll();
  await fs.writeFile(daemonDatedLogPath(root, new Date()), `${new Date().toISOString()} promoted-dated\n`);
  for (let i = 0; i < 4; i++) { polls.release(); await polls.waitUntilPoll(); }
  process.emit("SIGTERM");
  polls.release();
  await follow;
  expect(out.join("")).toContain("crash-only");
  expect(out.join("")).toContain("promoted-dated");
});

async function writeLifecycle(workspaceId: string, bootId: string): Promise<void> {
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({ remoteWorkspaceId: workspaceId }));
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(path.join(daemonRuntimeDir(root), "daemon.pid"), `v2 4242 ${bootId}\n`);
  await fs.writeFile(path.join(daemonRuntimeDir(root), "workspace.bound"), `v2 ${workspaceId} ${bootId}\n`);
}

test("follow exits on untrack, workspace rebinding, and an unrelated boot generation", async () => {
  for (const change of ["untrack", "binding", "boot"] as const) {
    out.length = 0;
    await writeLifecycle("ws-one", "boot-one");
    const polls = controlledPolls();
    const follow = logsDaemon(root, { follow: true, lines: 1 }, { waitForPoll: polls.waitForPoll });
    await polls.waitUntilPoll();
    if (change === "untrack") {
      await fs.rm(path.join(daemonRuntimeDir(root), "daemon.pid"));
      await fs.rm(path.join(daemonRuntimeDir(root), "workspace.bound"));
    } else if (change === "binding") {
      await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({ remoteWorkspaceId: "ws-two" }));
    } else {
      await fs.writeFile(path.join(daemonRuntimeDir(root), "daemon.pid"), "v2 4243 boot-two\n");
      await fs.writeFile(path.join(daemonRuntimeDir(root), "workspace.bound"), "v2 ws-one boot-two\n");
    }
    polls.release();
    await follow;
    await fs.rm(daemonRuntimeDir(root), { recursive: true, force: true });
    await fs.rm(path.join(root, ".rbox", "workspace.json"), { force: true });
  }
});

test("follow started before a daemon does not adopt a later boot generation", async () => {
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({ remoteWorkspaceId: "ws-one" }));
  const polls = controlledPolls();
  const follow = logsDaemon(root, { follow: true, lines: 1 }, { waitForPoll: polls.waitForPoll });
  await polls.waitUntilPoll();
  await writeLifecycle("ws-one", "boot-one");
  await fs.writeFile(daemonDatedLogPath(root, new Date()), `${new Date().toISOString()} adopted-boot\n`);
  polls.release();
  await follow;
  expect(out.join("")).not.toContain("adopted-boot");
});

test("follow rejects a generation replacement during initial source resolution", async () => {
  await writeLifecycle("ws-one", "boot-one");
  await fs.writeFile(daemonDatedLogPath(root, new Date()), `${new Date().toISOString()} boot-one-record\n`);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const resolving = new Promise<void>((resolve) => { entered = resolve; });
  const follow = logsDaemon(root, { follow: true, lines: 10 }, {
    resolveSources: async (sourceRoot, now) => {
      entered();
      await blocked;
      return resolveDaemonLogSources(sourceRoot, now);
    },
  });
  await resolving;
  await fs.writeFile(path.join(daemonRuntimeDir(root), "daemon.pid"), "v2 4243 boot-two\n");
  await fs.writeFile(path.join(daemonRuntimeDir(root), "workspace.bound"), "v2 ws-one boot-two\n");
  await fs.writeFile(daemonDatedLogPath(root, new Date()), `${new Date().toISOString()} boot-two-record\n`);
  release();
  await follow;
  expect(out.join("")).not.toContain("boot-two-record");
});

test("follow keeps legacy growth visible after dated promotion and exits for a legacy untrack", async () => {
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({ remoteWorkspaceId: "ws-legacy" }));
  await fs.writeFile(path.join(root, ".rbox", "daemon.log"), "legacy-initial\n");
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(path.join(daemonRuntimeDir(root), "daemon.pid"), "4242\n");
  await fs.writeFile(path.join(daemonRuntimeDir(root), "workspace.bound"), "ws-legacy\n");
  const polls = controlledPolls();
  const follow = logsDaemon(root, { follow: true, lines: 10 }, { waitForPoll: polls.waitForPoll });
  await polls.waitUntilPoll();
  await fs.writeFile(daemonDatedLogPath(root, new Date()), `${new Date().toISOString()} dated-promoted\n`);
  for (let i = 0; i < 4; i++) { polls.release(); await polls.waitUntilPoll(); }
  await fs.appendFile(path.join(root, ".rbox", "daemon.log"), "legacy-late-growth\n");
  polls.release();
  await polls.waitUntilPoll();
  await fs.rm(path.join(daemonRuntimeDir(root), "daemon.pid"));
  await fs.rm(path.join(daemonRuntimeDir(root), "workspace.bound"));
  polls.release();
  await follow;
  expect(out.join("")).toContain("dated-promoted");
  expect(out.join("")).toContain("legacy-late-growth");
});

test("follow treats same-path recreation as a new generation from offset zero", async () => {
  const crash = daemonCrashLogPath(root);
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(crash, "old-crash\n");
  const polls = controlledPolls();
  const follow = logsDaemon(root, { follow: true, lines: 10 }, { waitForPoll: polls.waitForPoll });
  await polls.waitUntilPoll();
  await fs.rm(crash);
  await fs.writeFile(crash, "recreated-from-zero\n");
  polls.release();
  await polls.waitUntilPoll();
  process.emit("SIGINT");
  polls.release();
  await follow;
  expect(out.join("")).toContain("recreated-from-zero");
});
