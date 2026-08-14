import { test, expect } from "bun:test";
import { daemonSpawnArgs } from "./daemon-control.js";
import { daemonSpawnEnv, parseDaemonTraceStreams } from "./daemon/process-control.js";
import { DAEMON_PROCESS_MARKER } from "./daemon/process-identity.js";

const MARKER = DAEMON_PROCESS_MARKER;
// Inside a COMPILED binary, process.argv[1] is Bun's virtual entry, not a real file.
const BUNFS_ENTRY = "/$bunfs/root/index.ts";
// Under `bun run`, process.argv[1] is the real script path.
const DEV_ENTRY = "/repo/src/cli/index.ts";
const ROOT = "/tmp/ws";

test("compiled binary omits the entry arg — the regression that made the daemon print help", () => {
  // Re-passing `entry` here is exactly what shifted the marker out of the child's
  // command slot and made the daemon print help (see daemonSpawnArgs). It must not be.
  const args = daemonSpawnArgs(BUNFS_ENTRY, ROOT, /* standalone */ true);
  expect(args).toEqual([MARKER, ROOT]);
  expect(args).not.toContain(BUNFS_ENTRY);
  expect(args[0]).toBe(MARKER); // marker leads → child parses it as the command
});

test("dev (bun run) keeps the script path so the child boots the right entry", () => {
  expect(daemonSpawnArgs(DEV_ENTRY, ROOT, /* standalone */ false)).toEqual([DEV_ENTRY, MARKER, ROOT]);
});

test("the marker is always present so `ps`-based PID-ownership checks can match it", () => {
  expect(daemonSpawnArgs(BUNFS_ENTRY, ROOT, true)).toContain(MARKER);
  expect(daemonSpawnArgs(DEV_ENTRY, ROOT, false)).toContain(MARKER);
});

test("trace parsing selects all streams or an exact comma list", () => {
  expect(parseDaemonTraceStreams("true")).toEqual(["propagation", "held"]);
  expect(parseDaemonTraceStreams("propagation,held")).toEqual(["propagation", "held"]);
  expect(parseDaemonTraceStreams("held")).toEqual(["held"]);
});

test("trace parsing rejects empty and unknown names with the valid list", () => {
  for (const value of ["", "propagation,nope"]) {
    expect(() => parseDaemonTraceStreams(value)).toThrow("valid streams: propagation, held");
  }
  expect(() => parseDaemonTraceStreams("propagation,nope")).toThrow("unknown trace stream nope");
});

test("spawn env keeps the default shape and overlays only selected trace streams", () => {
  const inherited = { KEEP: "yes", RBOX_TRACE_HELD: "inherited" };
  expect(daemonSpawnEnv(inherited, "boot-1", false)).toEqual({
    KEEP: "yes",
    RBOX_TRACE_HELD: "inherited",
    RBOX_DAEMON_BOOT_ID: "boot-1",
    RBOX_DAEMON_PULL_ONLY: "0",
  });
  expect(daemonSpawnEnv(inherited, "boot-2", true, ["propagation"])).toEqual({
    KEEP: "yes",
    RBOX_TRACE_HELD: "inherited",
    RBOX_TRACE_PROPAGATION: "1",
    RBOX_DAEMON_BOOT_ID: "boot-2",
    RBOX_DAEMON_PULL_ONLY: "1",
  });
  expect(daemonSpawnEnv({}, "boot-3", false, parseDaemonTraceStreams("true"))).toEqual({
    RBOX_TRACE_PROPAGATION: "1",
    RBOX_TRACE_HELD: "1",
    RBOX_DAEMON_BOOT_ID: "boot-3",
    RBOX_DAEMON_PULL_ONLY: "0",
  });
});
