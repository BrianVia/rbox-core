import { afterEach, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonLogHarvestScript, daemonWatcherMode, scrubSelfPrinted } from "./device.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// The CLI prints two secrets a redact-list can't know at call time (it generates
// them mid-run): the 24-word recovery phrase and the pairing token. The transcript
// scrub must catch exactly those line shapes and nothing that looks like normal
// sync output (pull summaries, corpus filenames).

const PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";
const PAIR = "tQx8mZ2kJ9vLpW3nRb4cYd.Fg7hKm1sTq5uVw9xZa3bCe6fHj8kMn2pRt4vWy7z";

test("scrub: a 24-word recovery-phrase line is masked (indentation kept)", () => {
  const out = scrubSelfPrinted(`    ${PHRASE}`);
  expect(out).toContain("[recovery phrase redacted]");
  expect(out).not.toContain("abandon");
  expect(out.startsWith("    ")).toBe(true);
});

test("scrub: a dot-joined pairing-token line is masked", () => {
  const out = scrubSelfPrinted(`    ${PAIR}\n\nOn the new machine: paste it.`);
  expect(out).toContain("[pairing token redacted]");
  expect(out).not.toContain(PAIR);
  expect(out).toContain("On the new machine");
});

test("scrub: pairing token inside the executable connect command is masked", () => {
  const token = `rbox-pair_${"a".repeat(16)}.${"b".repeat(43)}`;
  const out = scrubSelfPrinted(`    rbox connect ${token}`);
  expect(out).toBe("    rbox connect *** [pairing token redacted] ***");
  expect(out).not.toContain(token);
});

test("scrub: pull summaries and corpus filenames pass through untouched", () => {
  const body = [
    "pull applied: 1 write, 0 delete, 0 conflict — +b.txt",
    "  file0007.txt",
    "Pairing token (valid ~10 min, single use — carries your encryption key):",
    "a short sentence with lowercase words but far fewer than twenty",
  ].join("\n");
  expect(scrubSelfPrinted(body)).toBe(body);
});

test("daemon log harvest reads valid dated files in order, then the crash sink", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rbox rig logs "));
  tempDirs.push(home);
  const runtime = path.join(home, "daemons", "workspace-key");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, "daemon-2026-07-15.log"), "new-day\n");
  fs.writeFileSync(path.join(runtime, "daemon-2026-07-14.log"), "old-day\n");
  fs.writeFileSync(path.join(runtime, "daemon-2026-02-30.log"), "impossible\n");
  fs.writeFileSync(path.join(runtime, "daemon-2026-7-01.log"), "loose-name\n");
  fs.writeFileSync(path.join(runtime, "daemon.log"), "runtime-crash\n");

  const result = Bun.spawnSync(["sh", "-c", daemonLogHarvestScript(home)]);
  expect(result.exitCode).toBe(0);
  const out = result.stdout.toString();
  expect(out.indexOf("old-day")).toBeLessThan(out.indexOf("new-day"));
  expect(out.indexOf("new-day")).toBeLessThan(out.indexOf("runtime-crash"));
  expect(out).toContain("daemon-2026-07-14.log");
  expect(out).toContain("daemon.log (crash sink)");
  expect(out).not.toContain("impossible");
  expect(out).not.toContain("loose-name");
});

test("watcher classification consumes rollover-spanning operational output", () => {
  const combined = [
    "── daemon-2026-07-14.log ──",
    "2026-07-14T23:59:59.000Z daemon boot",
    "── daemon-2026-07-15.log ──",
    "2026-07-15T00:00:00.000Z live watch unavailable; degrading to periodic scan",
    "── daemon.log (crash sink) ──",
    "runtime diagnostic",
  ].join("\n");
  expect(daemonWatcherMode(combined)).toBe("polling");
});
