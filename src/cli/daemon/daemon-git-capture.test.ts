import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_BUSY_RETRY_DELAYS_MS, RboxDaemon, gitCaptureSampleForProvenance } from "./daemon.js";

describe("git capture push provenance", () => {
  test("uses mutually exclusive signal > candidate > scan precedence", () => {
    expect(gitCaptureSampleForProvenance({ signal: true, candidate: true, scan: true, other: true })).toEqual({
      kind: "git_capture", signalPushes: 1, candidatePushes: 0, scanPushes: 0,
    });
    expect(gitCaptureSampleForProvenance({ signal: false, candidate: true, scan: true, other: true })).toEqual({
      kind: "git_capture", signalPushes: 0, candidatePushes: 1, scanPushes: 0,
    });
    expect(gitCaptureSampleForProvenance({ signal: false, candidate: false, scan: true, other: true })).toEqual({
      kind: "git_capture", signalPushes: 0, candidatePushes: 0, scanPushes: 1,
    });
    expect(gitCaptureSampleForProvenance({ signal: false, candidate: false, scan: false, other: true })).toBeUndefined();
  });
});

test("git-busy retries are scheduled at two absolute episode offsets", () => {
  expect(GIT_BUSY_RETRY_DELAYS_MS).toEqual([2_000, 8_000]);
});

test("push provenance snapshots at dequeue and preserves later reasons for the next push", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-provenance-")));
  const cfg = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://example.invalid", token: "" };
  const daemon = new RboxDaemon(root, cfg as never, {} as never) as unknown as {
    requestPush(reason: "signal" | "candidate" | "scan" | "other"): void;
    takePushProvenance(): { signal: boolean; candidate: boolean; scan: boolean; other: boolean };
  };
  try {
    daemon.requestPush("signal");
    expect(daemon.takePushProvenance()).toEqual({ signal: true, candidate: false, scan: false, other: false });
    daemon.requestPush("candidate");
    expect(daemon.takePushProvenance()).toEqual({ signal: false, candidate: true, scan: false, other: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("every raw want.push assignment is owned by requestPush and terminal recording is at the normal return boundary", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("./daemon.ts", import.meta.url)), "utf8");
  expect(source.match(/this\.want\.push\s*=\s*true/g)).toHaveLength(1);
  const requestPush = source.slice(source.indexOf("private requestPush"), source.indexOf("private takePushProvenance"));
  expect(requestPush).toContain("this.want.push = true");
  expect(source.match(/this\.recordGitCaptureSuccess\(provenance\)/g)).toHaveLength(1);
  const returned = source.indexOf("res = await pushManifest");
  const recorded = source.indexOf("this.recordGitCaptureSuccess(provenance)");
  const bookkeeping = source.indexOf("this.manifest = res.manifest", recorded);
  expect(returned).toBeLessThan(recorded);
  expect(recorded).toBeLessThan(bookkeeping);
});
