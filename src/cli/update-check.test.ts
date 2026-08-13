import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatUpdateAvailableLine,
  maybeNudgeForUpdate,
  readUpdateCheckState,
  runUpdateCheckIfDue,
} from "./update-check.js";

let home: string;
let savedRboxHome: string | undefined;

function updateCheckPath(): string {
  return path.join(home, ".rbox", "update-check.json");
}

beforeEach(async () => {
  savedRboxHome = process.env.RBOX_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-update-check-"));
  process.env.RBOX_HOME = home;
});

afterEach(async () => {
  if (savedRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = savedRboxHome;
  await fs.rm(home, { recursive: true, force: true });
});

test("mocked manifest records an available version and status can render it", async () => {
  let fetches = 0;
  await runUpdateCheckIfDue("https://api.test", {
    now: () => new Date("2026-07-04T12:00:00.000Z"),
    fetchBytes: async () => {
      fetches++;
      return new Uint8Array([1, 2, 3]);
    },
    verifyManifest: () => ({ version: "99.0.0", keyId: "k", artifacts: {} }),
  });

  expect(fetches).toBe(2);
  const state = await readUpdateCheckState();
  expect(state).toEqual({ lastCheckedAt: "2026-07-04T12:00:00.000Z", lastKnownVersion: "99.0.0", lastNudgedVersion: null });
  expect(formatUpdateAvailableLine(state)).toContain("update available");
  expect(formatUpdateAvailableLine(state)).toContain("99.0.0");
});

test("within 24h does not refetch", async () => {
  await fs.mkdir(path.dirname(updateCheckPath()), { recursive: true });
  await fs.writeFile(
    updateCheckPath(),
    JSON.stringify({ lastCheckedAt: "2026-07-04T12:00:00.000Z", lastKnownVersion: "99.0.0", lastNudgedVersion: null })
  );
  let fetches = 0;
  await runUpdateCheckIfDue("https://api.test", {
    now: () => new Date("2026-07-05T11:59:59.000Z"),
    fetchBytes: async () => {
      fetches++;
      return new Uint8Array();
    },
    verifyManifest: () => {
      throw new Error("should not verify");
    },
  });
  expect(fetches).toBe(0);
});

test("future lastCheckedAt is treated as due and reset to now", async () => {
  await fs.mkdir(path.dirname(updateCheckPath()), { recursive: true });
  await fs.writeFile(
    updateCheckPath(),
    JSON.stringify({ lastCheckedAt: "2026-07-05T12:00:00.000Z", lastKnownVersion: "98.0.0", lastNudgedVersion: null })
  );
  let fetches = 0;
  await runUpdateCheckIfDue("https://api.test", {
    now: () => new Date("2026-07-04T12:00:00.000Z"),
    fetchBytes: async () => {
      fetches++;
      return new Uint8Array([1, 2, 3]);
    },
    verifyManifest: () => ({ version: "99.0.0", keyId: "k", artifacts: {} }),
  });

  expect(fetches).toBe(2);
  expect(await readUpdateCheckState()).toEqual({ lastCheckedAt: "2026-07-04T12:00:00.000Z", lastKnownVersion: "99.0.0", lastNudgedVersion: null });
});

test("fetch throw is silent and preserves no update line", async () => {
  await runUpdateCheckIfDue("https://api.test", {
    now: () => new Date("2026-07-04T12:00:00.000Z"),
    fetchBytes: async () => {
      throw new Error("offline");
    },
  });
  expect(formatUpdateAvailableLine(await readUpdateCheckState())).toBeUndefined();
});

test("interactive update nudge prints once per version", async () => {
  await fs.mkdir(path.dirname(updateCheckPath()), { recursive: true });
  await fs.writeFile(
    updateCheckPath(),
    JSON.stringify({ lastCheckedAt: "2026-07-04T12:00:00.000Z", lastKnownVersion: "99.0.0", lastNudgedVersion: null })
  );

  const notes: string[] = [];
  await maybeNudgeForUpdate({ isInteractive: () => true, writeStderr: (line) => notes.push(line) });
  await maybeNudgeForUpdate({ isInteractive: () => true, writeStderr: (line) => notes.push(line) });

  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("99.0.0");
  expect((await readUpdateCheckState())?.lastNudgedVersion).toBe("99.0.0");
});

test("dev build suppresses update nudge without writing state", async () => {
  await fs.mkdir(path.dirname(updateCheckPath()), { recursive: true });
  const state = { lastCheckedAt: "2026-07-04T12:00:00.000Z", lastKnownVersion: "99.0.0", lastNudgedVersion: null };
  await fs.writeFile(updateCheckPath(), JSON.stringify(state));

  const notes: string[] = [];
  await maybeNudgeForUpdate({
    currentVersion: "0.9.1-dev+03ff993.dirty",
    isInteractive: () => true,
    writeStderr: (line) => notes.push(line),
  });

  expect(notes).toHaveLength(0);
  expect(await readUpdateCheckState()).toEqual(state);
});
