import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveStateUnsafeLegacyOrTest, syncStreamId, type WorkspaceConfig } from "../config.js";
import type { CommitResult } from "../remote.js";
import {
  accumulateRecoveryPage,
  push,
  PushConflictExhaustedError,
} from "./push.js";
import { PUSH_CONFLICT_SURRENDER_MS } from "./policy.js";
import { deps, FakeRemote, KEK } from "./publication.test-helper.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

let root: string;
let cfg: WorkspaceConfig;
let savedPreflightDelta: string | undefined;
let savedFilesFirst: string | undefined;

beforeEach(async () => {
  savedPreflightDelta = process.env.RBOX_PREFLIGHT_DELTA;
  savedFilesFirst = process.env.RBOX_FILES_FIRST;
  delete process.env.RBOX_PREFLIGHT_DELTA;
  delete process.env.RBOX_FILES_FIRST;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-publication-contract-"));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  cfg = {
    remoteWorkspaceId: "ws_publication_contract",
    projectId: "root",
    deviceId: "dev-publication-contract",
    rootPath: root,
    remoteUrl: "http://x",
    token: "",
    encrypted: true,
    kek: KEK,
    accountId: "acct_publication_contract",
    accountEpoch: 0,
    keyEpoch: 0,
  };
  await seedLegacyState(root, cfg);
});

async function seedLegacyState(workspaceRoot: string, config: WorkspaceConfig): Promise<void> {
  await saveStateUnsafeLegacyOrTest(workspaceRoot, {
    stream: syncStreamId(config), stateNonce: "a".repeat(32), stateRevision: 0,
    lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] },
  });
}

afterEach(async () => {
  if (savedPreflightDelta === undefined) delete process.env.RBOX_PREFLIGHT_DELTA;
  else process.env.RBOX_PREFLIGHT_DELTA = savedPreflightDelta;
  if (savedFilesFirst === undefined) delete process.env.RBOX_FILES_FIRST;
  else process.env.RBOX_FILES_FIRST = savedFilesFirst;
  await fs.rm(root, { recursive: true, force: true });
});

const write = (relativePath: string, content: string) => fs.writeFile(path.join(root, relativePath), content);

describe("Publication bounded retry contract", () => {
  // Consolidates the protected pin in sync.test.ts, "409 forever".
  test("attempt-budget exhaustion stops after the initial attempt plus five retries", async () => {
    const remote = new FakeRemote();
    await write("mine.txt", "mine\n");
    let injected = 0;
    remote.beforeCommit = async () => {
      injected += 1;
      remote.injectCommit([await remote.seedEntry(`remote-${injected}.txt`, `remote-${injected}\n`)]);
    };

    await expect(push(root, cfg, deps(remote))).rejects.toThrow(/too many conflicts/);
    expect(remote.commitCalls).toBe(6);
    expect(remote.headSeq()).toBe(6);
  });

  // Consolidates sync.test.ts's design 244 slow-recovery-pull pin.
  test("conflict surrender is checked before another attempt starts", async () => {
    const remote = new FakeRemote();
    await write("mine.txt", "mine\n");
    let clock = 0;
    remote.beforeCommit = async () => {
      remote.injectCommit([await remote.seedEntry("remote.txt", "remote\n")]);
    };

    await expect(push(root, cfg, {
      ...deps(remote),
      now: () => clock,
      onPullApplied: () => { clock += PUSH_CONFLICT_SURRENDER_MS + 1; },
    })).rejects.toBeInstanceOf(PushConflictExhaustedError);
    expect(remote.commitCalls).toBe(1);
  });

  // Consolidates sync.test.ts's decreasing/non-decreasing missingTotal pins.
  test("only non-shrinking unsatisfied pages consume the shared attempt budget", async () => {
    const shrinking = new FakeRemote();
    shrinking.forceUnsatisfiedTotals = [60_000, 50_000, 40_000, 30_000, 20_000, 10_000];
    await write("x.txt", "payload\n");
    expect((await push(root, cfg, deps(shrinking))).sequence).toBe(1);
    expect(shrinking.commitCalls).toBe(7);

    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-publication-contract-fixed-"));
    try {
      await fs.mkdir(path.join(secondRoot, ".rbox", "state"), { recursive: true });
      await seedLegacyState(secondRoot, { ...cfg, rootPath: secondRoot });
      await fs.writeFile(path.join(secondRoot, "x.txt"), "payload\n");
      const fixed = new FakeRemote();
      fixed.forceUnsatisfiedTotals = Array.from({ length: 10 }, () => 10_000);
      await expect(push(secondRoot, { ...cfg, rootPath: secondRoot }, deps(fixed)))
        .rejects.toThrow(/server keeps reporting missing blobs/);
      expect(fixed.commitCalls).toBe(6);
    } finally {
      await fs.rm(secondRoot, { recursive: true, force: true });
    }
  });
});

describe("Publication RecoveryAction arms", () => {
  // Consolidates sync.test.ts's 409 pull + re-scan pin.
  test("pull-first preserves both the remote advance and the local candidate", async () => {
    const remote = new FakeRemote();
    await write("mine.txt", "mine\n");
    let inject = true;
    remote.beforeCommit = async () => {
      if (!inject) return;
      inject = false;
      remote.injectCommit([await remote.seedEntry("theirs.txt", "theirs\n")]);
    };

    const result = await push(root, cfg, deps(remote));
    expect(result.sequence).toBe(remote.headSeq());
    expect(remote.commitCalls).toBeGreaterThanOrEqual(2);
    expect((await remote.latest()).manifest.files.map((file) => file.path).sort())
      .toEqual(["mine.txt", "theirs.txt"]);
  });

  // Consolidates sync.test.ts's epoch-refresh accumulator-reset pin.
  test("epoch-stale refreshes write context and retries the rebuilt candidate", async () => {
    const remote = new FakeRemote() as FakeRemote & {
      currentKek: () => Promise<{ kek: Uint8Array; accountId: string; accountEpoch: number; keyEpoch: number }>;
    };
    remote.currentKek = async () => ({
      kek: KEK,
      accountId: cfg.accountId!,
      accountEpoch: cfg.accountEpoch!,
      keyEpoch: cfg.keyEpoch!,
    });
    await write("x.txt", "payload\n");
    const originalCommit = remote.commit.bind(remote);
    let stale = true;
    let commitInvocations = 0;
    remote.commit = async (...args): Promise<CommitResult> => {
      commitInvocations += 1;
      if (stale) {
        stale = false;
        return { epochStale: cfg.accountEpoch! + 1 };
      }
      return originalCommit(...args);
    };

    const result = await push(root, cfg, deps(remote));
    expect(result.committed).toBe(true);
    expect(result.sequence).toBe(1);
    expect(commitInvocations).toBe(2);
    expect(remote.commitCalls).toBe(1);
  });

  // Consolidates sync.test.ts's forced-unsatisfied reupload pin.
  test("reupload retries the same publication candidate to acceptance", async () => {
    const remote = new FakeRemote();
    remote.forceUnsatisfiedOnce = true;
    await write("x.txt", "payload\n");

    const result = await push(root, cfg, deps(remote));
    expect(result.committed).toBe(true);
    expect(remote.commitCalls).toBe(2);
  });

  // Consolidates sync.test.ts's accumulator overflow/full-audit pin.
  test("RECOVER_ACCUM_MAX overflow latches forceFullAudit and bounds retained addresses", async () => {
    const addresses = new Set<string>();
    const atCap = Array.from({ length: 100_000 }, (_, index) => sha(`at-cap-${index}`));
    expect(accumulateRecoveryPage(addresses, false, atCap)).toBe(false);
    expect(addresses.size).toBe(100_000);
    expect(accumulateRecoveryPage(addresses, false, [sha("overflow")])).toBe(true);
    expect(addresses.size).toBe(0);
    expect(accumulateRecoveryPage(addresses, true, [sha("post-overflow")])).toBe(true);
    expect(addresses.size).toBe(0);

    const source = await fs.readFile(new URL("./push.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "state.forceFullAudit = accumulateRecoveryPage(state.recoverAddresses, state.forceFullAudit, outcome.action.unsatisfiedBlobs)",
    );
    expect(source).toContain("const { purgeIgnored, forceGitRecapture, recoverAddresses, forceFullAudit");
  });

  // Consolidates files-first.test.ts's starvation-fallback pin. This structural
  // assertion protects its independent cap without duplicating the git fixture.
  test("files-first fallback has one independent use and does not spend an attempt", async () => {
    const source = await fs.readFile(new URL("./push.ts", import.meta.url), "utf8");
    const arm = source.slice(
      source.indexOf('if (outcome.action.kind === "files-first-fallback")'),
      source.indexOf('if (outcome.action.kind === "pull-first") firstConflictAt'),
    );
    expect(arm).toContain("if (state.filesFirstFallbackUsed) throw new Error(outcome.exhaustedError)");
    expect(arm).toContain("state.filesFirstFallbackUsed = true");
    expect(arm).toContain("continue; // does NOT increment attempt");
    expect(arm).not.toContain("attempt++");
  });
});
