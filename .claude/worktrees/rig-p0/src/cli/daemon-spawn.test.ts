import { test, expect } from "bun:test";
import { daemonSpawnArgs } from "./daemon-control.js";

const MARKER = "__daemon-run";
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
