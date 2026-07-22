import { expect, test } from "bun:test";
import {
  design180GenesisSeam,
  retargetThenWriteFallback,
  shouldPresentGenesisCompletion,
  type CompletionIntent,
  type CommittedGenesisClassification,
  type GenesisSeam,
} from "./genesis-seam.js";
import { completeStagedGenesisRecoveryKit } from "./auth-cmd.js";
import { phraseToRk } from "../engine/e2ee/index.js";
import { beginAtomicGenesis } from "./e2ee-client.js";
import type { AccountKeysDTO, GenesisAccountObservation, GenesisPresence } from "./e2ee-remote.js";
import { genesisPaths } from "./genesis-durable.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveCredentials } from "./credentials.js";

const oldIntent: Extract<CompletionIntent, { mode: "keychain" }> = {
  version: 1, accountId: "acct_0123456789abcdef", requestSha256: "a".repeat(64), mode: "keychain",
  keychain: { service: "rbox recovery phrase", account: "acct_0123456789abcdef", keychainPath: "/tmp/login.keychain-db" },
  intentAt: "2026-07-22T12:00:00.000Z",
};
const newIntent: Extract<CompletionIntent, { mode: "kit-path" }> = {
  version: 1, accountId: oldIntent.accountId, requestSha256: oldIntent.requestSha256, mode: "kit-path",
  path: "/tmp/recovery.txt", intentAt: "2026-07-22T12:01:00.000Z",
};
const committed: CommittedGenesisClassification = {
  kind: "committed-this-attempt",
  journal: { accountId: oldIntent.accountId, requestSha256: oldIntent.requestSha256 },
  phrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
};

function fakeRetarget(fn: GenesisSeam["retargetKeychainIntent"]): GenesisSeam {
  const fail = async (): Promise<never> => { throw new Error("unused"); };
  return {
    withAccountGenesisLock: async (_accountId, operation) => operation(),
    resumeOrCleanupPendingGenesis: fail,
    readValidatedStagedRecoveryKey: async () => undefined,
    readAndReconcileCompletionIntent: async () => ({ state: "absent" }),
    writeCompletionIntent: fail,
    retargetKeychainIntent: fn,
    pendingGenesis: async () => committed,
    commitVerifiedRecoveryKitArtifact: fail,
    commitDeliveredRecoveryPhrase: fail,
    quarantineAbandonedAttempt: fail,
  };
}

test("an active unresolved journal re-presents after crash-after-claim, but a target suppresses reselection", () => {
  expect(shouldPresentGenesisCompletion(true, committed, { state: "absent" })).toBe(true);
  expect(shouldPresentGenesisCompletion(true, committed, { state: "intent", intent: oldIntent })).toBe(false);
  expect(shouldPresentGenesisCompletion(true, "none", { state: "absent" })).toBe(false);
  expect(shouldPresentGenesisCompletion(false, "none", { state: "absent" })).toBe(true);
});

test("RETARGET failure or old survivor performs no fallback write", async () => {
  let writes = 0;
  await expect(retargetThenWriteFallback(fakeRetarget(async () => { throw new Error("after rename"); }), committed, oldIntent, newIntent, async () => { writes++; })).rejects.toThrow(/after rename/);
  expect(writes).toBe(0);
  expect(await retargetThenWriteFallback(fakeRetarget(async () => oldIntent), committed, oldIntent, newIntent, async () => { writes++; })).toBe("keychain-retained");
  expect(writes).toBe(0);
});

test("only the exact reconciled new intent permits the fallback file", async () => {
  const paths: string[] = [];
  expect(await retargetThenWriteFallback(fakeRetarget(async () => newIntent), committed, oldIntent, newIntent, async (value) => { paths.push(value); })).toBe("file-written");
  expect(paths).toEqual([newIntent.path]);
  await expect(retargetThenWriteFallback(
    fakeRetarget(async () => ({ ...newIntent, intentAt: "2026-07-22T12:02:00.000Z" })),
    committed,
    oldIntent,
    newIntent,
    async () => { paths.push("unexpected"); }
  )).rejects.toThrow(/unexpected completion intent/);
  await expect(retargetThenWriteFallback(
    fakeRetarget(async () => ({ ...oldIntent, keychain: { ...oldIntent.keychain, keychainPath: "/third.keychain" } })),
    committed,
    oldIntent,
    newIntent,
    async () => { paths.push("unexpected"); }
  )).rejects.toThrow(/unexpected completion intent/);
  expect(paths).toEqual([newIntent.path]);
});

test("staged completion publishes intent before artifact and receipt", async () => {
  const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  const stagedRk = await phraseToRk(phrase);
  const trace: string[] = [];
  const seam: GenesisSeam = {
    withAccountGenesisLock: async (_accountId, operation) => operation(),
    resumeOrCleanupPendingGenesis: async () => {},
    readValidatedStagedRecoveryKey: async () => ({ accountId: oldIntent.accountId, requestSha256: oldIntent.requestSha256, originalCacheRecovery: false, rk: stagedRk }),
    readAndReconcileCompletionIntent: async () => ({ state: "absent" }),
    writeCompletionIntent: async () => { trace.push("intent"); },
    retargetKeychainIntent: async () => oldIntent,
    pendingGenesis: async () => committed,
    commitVerifiedRecoveryKitArtifact: async () => { trace.push("receipt"); },
    commitDeliveredRecoveryPhrase: async () => { trace.push("phrase-receipt"); },
    quarantineAbandonedAttempt: async () => {},
  };
  await completeStagedGenesisRecoveryKit(oldIntent.accountId, committed, seam, {
    validatePhrase: async (candidate) => { expect(candidate).toBe(phrase); trace.push("validated"); },
    select: async () => { trace.push("selected"); return oldIntent; },
    displayPhrase: async () => { throw new Error("wrong mode"); },
    saveKeychain: async (_candidate, intent) => { expect(intent).toEqual(oldIntent); trace.push("artifact"); },
    saveFile: async () => { throw new Error("wrong mode"); },
    offerClaimed: async () => true,
  });
  expect(trace).toEqual(["validated", "selected", "intent", "artifact", "receipt"]);
  expect(stagedRk.every((byte) => byte === 0)).toBe(true);
});

test("production staged flow orders durable intent, Keychain failure, RETARGET, file, then receipt", async () => {
  const stagedRk = await phraseToRk(committed.phrase);
  const trace: string[] = [];
  const seam: GenesisSeam = {
    withAccountGenesisLock: async (_accountId, operation) => operation(),
    pendingGenesis: async () => committed,
    resumeOrCleanupPendingGenesis: async () => { throw new Error("unused") },
    readValidatedStagedRecoveryKey: async () => ({ ...committed.journal, originalCacheRecovery: false, rk: stagedRk }),
    readAndReconcileCompletionIntent: async () => { trace.push("reconcile"); return { state: "absent" } },
    writeCompletionIntent: async (classification, intent) => { expect(classification).toBe(committed); expect(intent).toEqual(oldIntent); trace.push("intent") },
    retargetKeychainIntent: async (classification, old, next) => { expect(classification).toBe(committed); expect(old).toEqual(oldIntent); expect(next).toEqual(newIntent); trace.push("retarget"); return next },
    commitVerifiedRecoveryKitArtifact: async (classification) => { expect(classification).toBe(committed); trace.push("receipt") },
    commitDeliveredRecoveryPhrase: async () => { throw new Error("wrong receipt") },
    quarantineAbandonedAttempt: async () => { throw new Error("unused") },
  };
  await completeStagedGenesisRecoveryKit(oldIntent.accountId, committed, seam, {
    validatePhrase: async () => { trace.push("validate") },
    select: async () => { trace.push("select"); return oldIntent },
    displayPhrase: async () => { throw new Error("wrong mode") },
    saveKeychain: async () => { trace.push("keychain"); throw new Error("Keychain unavailable") },
    retargetAfterKeychainFailure: async () => { trace.push("consent"); return newIntent },
    saveFile: async (_phrase, intent) => { expect(intent).toEqual(newIntent); trace.push("file") },
    offerClaimed: async () => true,
  });
  expect(trace).toEqual(["reconcile", "validate", "select", "intent", "keychain", "consent", "retarget", "file", "receipt"]);
  expect(stagedRk.every((byte) => byte === 0)).toBe(true);
});

test("production staged RETARGET failure writes no fallback file or receipt", async () => {
  const stagedRk = await phraseToRk(committed.phrase);
  let files = 0;
  let receipts = 0;
  const seam: GenesisSeam = {
    ...fakeRetarget(async () => { throw new Error("retarget durability failed") }),
    readValidatedStagedRecoveryKey: async () => ({ ...committed.journal, originalCacheRecovery: false, rk: stagedRk }),
    writeCompletionIntent: async () => {},
    commitVerifiedRecoveryKitArtifact: async () => { receipts++ },
  };
  await expect(completeStagedGenesisRecoveryKit(oldIntent.accountId, committed, seam, {
    validatePhrase: async () => {},
    select: async () => oldIntent,
    displayPhrase: async () => { throw new Error("wrong mode") },
    saveKeychain: async () => { throw new Error("Keychain unavailable") },
    retargetAfterKeychainFailure: async () => newIntent,
    saveFile: async () => { files++ },
    offerClaimed: async () => true,
  })).rejects.toThrow(/retarget durability failed/);
  expect({ files, receipts }).toEqual({ files: 0, receipts: 0 });
  expect(stagedRk.every((byte) => byte === 0)).toBe(true);
});

test("the production seam delegates intent, RETARGET, receipt, and cleanup to design 180", async () => {
  const previousHome = process.env.RBOX_HOME;
  const previousOsHome = process.env.HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-genesis-seam-real-"));
  process.env.RBOX_HOME = home;
  process.env.HOME = home;
  let claim: AccountKeysDTO | undefined;
  const present: GenesisPresence = { rosters: 1, keyStates: 1, devices: 1, workspaces: 0, workspaceKeys: 0, e2eePairingTokens: 0 };
  const api = {
    getGenesisObservation: async (): Promise<GenesisAccountObservation> => claim
      ? { genesisPresenceVersion: 1, claim, present, repairTombstone: null }
      : { genesisPresenceVersion: 1, claim: null, present: { rosters: 0, keyStates: 0, devices: 0, workspaces: 0, workspaceKeys: 0, e2eePairingTokens: 0 } },
    bootstrapKeys: async (raw: unknown) => {
      const body = JSON.parse(String(raw)) as { recoveryWrap: string; recoveryWrapId: string; genesisRoster: string; genesisKeyState: string; device: { deviceId: string; sigPubKey: string; encPubKey: string; mkWrap: string } };
      claim = {
        genesisPresenceVersion: 1,
        recoveryWrap: body.recoveryWrap,
        recoveryWrapId: body.recoveryWrapId,
        claimCreatedAt: 1_900_000_000_000,
        genesisDeviceId: body.device.deviceId,
        rosters: [body.genesisRoster],
        keyStates: [body.genesisKeyState],
        devices: [{ deviceId: body.device.deviceId, sigPubkey: body.device.sigPubKey, encPubkey: body.device.encPubKey, mkWrap: body.device.mkWrap }],
        present,
        repairTombstone: null,
      };
    },
  };
  const started = await beginAtomicGenesis(api, oldIntent.accountId, "dev_real_seam", { now: 1_900_000_000_000 });
  expect(started.kind).toBe("committed");
  if (started.kind !== "committed") throw new Error("expected committed genesis");
  const keychainIntent = { ...oldIntent, requestSha256: started.journal.requestSha256, intentAt: "2030-03-17T17:46:40.000Z" };
  const fileIntent = { ...newIntent, requestSha256: started.journal.requestSha256, intentAt: "2030-03-17T17:46:41.000Z" };
  await started.lock.release();
  await started.globalLock.release();
  await saveCredentials({ token: "tok", deviceId: "dev_real_seam", remoteUrl: "https://api.test", accountId: oldIntent.accountId });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ...claim!, genesisPresenceVersion: 1, present, repairTombstone: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    const stale: CommittedGenesisClassification = { kind: "committed-this-attempt", journal: started.journal, phrase: started.phrase };
    await expect(design180GenesisSeam.readAndReconcileCompletionIntent(stale)).rejects.toThrow(/requires the account lock/);
    await design180GenesisSeam.withAccountGenesisLock(oldIntent.accountId, async () => {
      const classification = await design180GenesisSeam.pendingGenesis(oldIntent.accountId);
      expect(classification).not.toBe("none");
      if (classification === "none" || classification.kind !== "committed-this-attempt") throw new Error("expected committed classification");
      const staged = await design180GenesisSeam.readValidatedStagedRecoveryKey(classification);
      expect(staged?.requestSha256).toBe(started.journal.requestSha256);
      staged?.rk.fill(0);
      expect(await design180GenesisSeam.readAndReconcileCompletionIntent(classification)).toEqual({ state: "absent" });
      await design180GenesisSeam.writeCompletionIntent(classification, keychainIntent);
      expect(await design180GenesisSeam.readAndReconcileCompletionIntent(classification)).toEqual({ state: "intent", intent: keychainIntent });
      expect(await design180GenesisSeam.retargetKeychainIntent(classification, keychainIntent, fileIntent)).toEqual(fileIntent);
      await design180GenesisSeam.commitVerifiedRecoveryKitArtifact(classification);
    });
    await expect(fs.access(genesisPaths(oldIntent.accountId).journal)).rejects.toThrow();
    await expect(fs.access(genesisPaths(oldIntent.accountId).intent)).rejects.toThrow();
    await expect(fs.access(genesisPaths(oldIntent.accountId).stagedRk)).rejects.toThrow();
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.RBOX_HOME;
    else process.env.RBOX_HOME = previousHome;
    if (previousOsHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousOsHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});
