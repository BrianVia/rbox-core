import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher } from "../../engine/index.js";
import { RETRUST_EPISODE_COALESCE_MS } from "./policy.js";
import { WatcherTrust, type WatcherTrustPort } from "./watcher-trust.js";

const DROP = "Events were dropped by the FSEvents client. File system must be re-scanned.";
let previousFlag: string | undefined;

beforeEach(() => {
  previousFlag = process.env.RBOX_WATCHER_RETRUST;
  process.env.RBOX_WATCHER_RETRUST = "1";
});

afterEach(() => {
  if (previousFlag === undefined) delete process.env.RBOX_WATCHER_RETRUST;
  else process.env.RBOX_WATCHER_RETRUST = previousFlag;
});

class TrustHarness {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-watcher-trust-")));
  readonly logs: string[] = [];
  readonly contaminations: Array<{ watcherHealthy: false; trustState?: "trusted" | "suspect" | "fused" }> = [];
  readonly calls = { fuse: 0, fatal: 0, status: 0, floor: 0 };
  watcher: { backend: "parcel" | "chokidar" } | undefined = { backend: "parcel" };
  ignorePaths: string[] = [];
  now = 0;
  readonly trust: WatcherTrust;

  constructor() {
    const port: WatcherTrustPort = {
      watcher: () => this.watcher,
      respectGitignore: () => false,
      ignorePaths: () => this.ignorePaths,
      knownGitRepos: () => [],
      externalLocalWorkSettled: () => true,
      fuseSession: () => { this.calls.fuse++; },
      fatalSession: () => { this.calls.fatal++; },
      contaminateAudits: (input) => { this.contaminations.push(input); },
      statusChanged: () => { this.calls.status++; },
      pinSafetyFloor: () => { this.calls.floor++; },
      log: (line) => { this.logs.push(line); },
    };
    this.trust = new WatcherTrust(this.root, port, { monotonicNow: () => this.now });
  }

  drop(): void {
    this.trust.observe({ kind: "error", error: new Error(DROP) });
  }

  close(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

test("machine-local ignore changes the watcher authority fingerprint", () => {
  const harness = new TrustHarness();
  try {
    const before = harness.trust.armCertification(buildIgnoreMatcher(harness.root));
    harness.ignorePaths = ["machine-only"];
    const after = harness.trust.armCertification(buildIgnoreMatcher(harness.root, { ignorePaths: harness.ignorePaths }));
    expect(after.authorityFingerprint).not.toBe(before.authorityFingerprint);
  } finally {
    harness.close();
  }
});

test("episode fuse and suspect re-trust use the injected monotonic clock", () => {
  const burst = new TrustHarness();
  try {
    for (let index = 0; index < 6; index++) burst.drop();
    expect(burst.trust.snapshot()).toMatchObject({ state: "suspect", errorGeneration: 6, live: false });
    burst.now = 60_000;
    burst.trust.observe({
      kind: "scan",
      operationErrorGeneration: 6,
      receipt: { coverage: "full-tree", errorGenAtStart: 6 },
    });
    expect(burst.trust.snapshot()).toMatchObject({ state: "trusted", live: true, degraded: false });
  } finally {
    burst.close();
  }

  const spaced = new TrustHarness();
  try {
    for (let index = 0; index < 6; index++) {
      spaced.drop();
      spaced.now += RETRUST_EPISODE_COALESCE_MS;
    }
    expect(spaced.trust.snapshot().state).toBe("fused");
    expect(spaced.calls.fuse).toBe(1);
    spaced.trust.observe({
      kind: "scan",
      operationErrorGeneration: 6,
      receipt: { coverage: "full-tree", errorGenAtStart: 6 },
    });
    expect(spaced.trust.snapshot().state).toBe("fused");
  } finally {
    spaced.close();
  }
});

test("flag-off errors contaminate health only and never signal the supervisor", () => {
  process.env.RBOX_WATCHER_RETRUST = "0";
  const harness = new TrustHarness();
  try {
    harness.trust.observe({ kind: "error", error: new Error("fatal stream failure") });
    expect(harness.trust.snapshot()).toMatchObject({ state: "trusted", live: false, degraded: true, errorGeneration: 1 });
    expect(harness.contaminations).toEqual([{ watcherHealthy: false }]);
    expect(harness.calls).toEqual({ fuse: 0, fatal: 0, status: 1, floor: 1 });
  } finally {
    harness.close();
  }
});

test("watch activity, scan testimony, and quiet ticks jointly permit suspect cadence backoff", () => {
  const harness = new TrustHarness();
  try {
    harness.drop();
    harness.trust.observe({
      kind: "scan",
      operationErrorGeneration: 1,
      receipt: { coverage: "full-tree", errorGenAtStart: 1 },
    });
    for (let index = 0; index < 3; index++) harness.trust.observe({ kind: "safety-tick", churned: false });
    expect(harness.trust.liveEnoughToSkipSafetyScan()).toBe(false);
    harness.trust.observe({ kind: "watch-activity" });
    expect(harness.trust.liveEnoughToSkipSafetyScan()).toBe(true);
    harness.trust.observe({ kind: "safety-tick", churned: true });
    expect(harness.trust.liveEnoughToSkipSafetyScan()).toBe(false);
  } finally {
    harness.close();
  }
});

test("raw-event and operation witnesses own local unsettled generation", () => {
  const harness = new TrustHarness();
  try {
    const operation = harness.trust.captureOperation();
    expect(harness.trust.observe({ kind: "raw-event" })).toEqual({ wasUnsettled: false });
    expect(harness.trust.observe({ kind: "raw-event" })).toEqual({ wasUnsettled: true });
    harness.trust.observe({
      kind: "operation-complete",
      operationEventGeneration: operation.eventGeneration,
      pendingEvents: false,
      refreshedLocalTruth: true,
    });
    expect(harness.trust.localSettled()).toBe(false);
    const covering = harness.trust.captureOperation();
    harness.trust.observe({
      kind: "operation-complete",
      operationEventGeneration: covering.eventGeneration,
      pendingEvents: false,
      refreshedLocalTruth: true,
    });
    expect(harness.trust.localSettled()).toBe(true);
  } finally {
    harness.close();
  }
});

test("matcher coverage changes fuse while unchanged Parcel authority remains trusted", async () => {
  const harness = new TrustHarness();
  try {
    const matcher = buildIgnoreMatcher(harness.root, { respectGitignore: false });
    const authority = harness.trust.armAuthority(4, matcher);
    harness.trust.observe({ kind: "session-installed", admissionFingerprint: authority.admission.join("\n") });
    harness.trust.observe({ kind: "matcher-rebuilt", matcher });
    expect(harness.trust.snapshot().state).toBe("trusted");

    await fs.promises.writeFile(path.join(harness.root, ".rboxignore"), "!node_modules/\n");
    const expanded = buildIgnoreMatcher(harness.root, { respectGitignore: false });
    harness.trust.observe({ kind: "matcher-rebuilt", matcher: expanded });
    expect(harness.trust.snapshot().state).toBe("fused");
  } finally {
    harness.close();
  }
});
