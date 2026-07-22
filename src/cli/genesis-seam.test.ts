import { expect, test } from "bun:test";
import {
  retargetThenWriteFallback,
  shouldPresentGenesisCompletion,
  type CompletionIntent,
  type GenesisSeam,
} from "./genesis-seam.js";
import { completeStagedGenesisRecoveryKit } from "./auth-cmd.js";
import { phraseToRk } from "../engine/e2ee/index.js";

const oldIntent: Extract<CompletionIntent, { mode: "keychain" }> = {
  version: 1, accountId: "acct_0123456789abcdef", requestSha256: "a".repeat(64), mode: "keychain",
  keychain: { service: "rbox recovery phrase", account: "acct_0123456789abcdef", keychainPath: "/tmp/login.keychain-db" },
  intentAt: "2026-07-22T12:00:00.000Z",
};
const newIntent: Extract<CompletionIntent, { mode: "kit-path" }> = {
  version: 1, accountId: oldIntent.accountId, requestSha256: oldIntent.requestSha256, mode: "kit-path",
  path: "/tmp/recovery.txt", intentAt: "2026-07-22T12:01:00.000Z",
};

function fakeRetarget(fn: GenesisSeam["retargetKeychainIntent"]): GenesisSeam {
  const fail = async (): Promise<never> => { throw new Error("unused"); };
  return {
    readValidatedStagedRecoveryKey: async () => undefined,
    readAndReconcileCompletionIntent: async () => ({ state: "absent" }),
    writeCompletionIntent: fail,
    retargetKeychainIntent: fn,
    pendingGenesis: async () => "unreleased-recovery-kit-hold",
    commitVerifiedRecoveryKitArtifact: fail,
    commitDeliveredRecoveryPhrase: fail,
    quarantineAbandonedAttempt: fail,
  };
}

test("an active unresolved journal re-presents after crash-after-claim, but a target suppresses reselection", () => {
  expect(shouldPresentGenesisCompletion(true, "unreleased-recovery-kit-hold", { state: "absent" })).toBe(true);
  expect(shouldPresentGenesisCompletion(true, "unreleased-recovery-kit-hold", { state: "intent", intent: oldIntent })).toBe(false);
  expect(shouldPresentGenesisCompletion(true, "none", { state: "absent" })).toBe(false);
  expect(shouldPresentGenesisCompletion(false, "none", { state: "absent" })).toBe(true);
});

test("RETARGET failure or old survivor performs no fallback write", async () => {
  let writes = 0;
  await expect(retargetThenWriteFallback(fakeRetarget(async () => { throw new Error("after rename"); }), oldIntent, newIntent, async () => { writes++; })).rejects.toThrow(/after rename/);
  expect(writes).toBe(0);
  expect(await retargetThenWriteFallback(fakeRetarget(async () => oldIntent), oldIntent, newIntent, async () => { writes++; })).toBe("keychain-retained");
  expect(writes).toBe(0);
});

test("only the exact reconciled new intent permits the fallback file", async () => {
  const paths: string[] = [];
  expect(await retargetThenWriteFallback(fakeRetarget(async () => newIntent), oldIntent, newIntent, async (value) => { paths.push(value); })).toBe("file-written");
  expect(paths).toEqual([newIntent.path]);
  await expect(retargetThenWriteFallback(
    fakeRetarget(async () => ({ ...newIntent, intentAt: "2026-07-22T12:02:00.000Z" })),
    oldIntent,
    newIntent,
    async () => { paths.push("unexpected"); }
  )).rejects.toThrow(/unexpected completion intent/);
  await expect(retargetThenWriteFallback(
    fakeRetarget(async () => ({ ...oldIntent, keychain: { ...oldIntent.keychain, keychainPath: "/third.keychain" } })),
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
    readValidatedStagedRecoveryKey: async () => ({ accountId: oldIntent.accountId, requestSha256: oldIntent.requestSha256, originalCacheRecovery: false, rk: stagedRk }),
    readAndReconcileCompletionIntent: async () => ({ state: "absent" }),
    writeCompletionIntent: async () => { trace.push("intent"); },
    retargetKeychainIntent: async () => oldIntent,
    pendingGenesis: async () => "unreleased-recovery-kit-hold",
    commitVerifiedRecoveryKitArtifact: async () => { trace.push("receipt"); },
    commitDeliveredRecoveryPhrase: async () => { trace.push("phrase-receipt"); },
    quarantineAbandonedAttempt: async () => {},
  };
  await completeStagedGenesisRecoveryKit(oldIntent.accountId, seam, {
    validatePhrase: async (candidate) => { expect(candidate).toBe(phrase); trace.push("validated"); },
    select: async () => { trace.push("selected"); return oldIntent; },
    displayPhrase: async () => { throw new Error("wrong mode"); },
    saveKeychain: async (_candidate, intent) => { expect(intent).toEqual(oldIntent); trace.push("artifact"); },
    saveFile: async () => { throw new Error("wrong mode"); },
  });
  expect(trace).toEqual(["validated", "selected", "intent", "artifact", "receipt"]);
  expect(stagedRk.every((byte) => byte === 0)).toBe(true);
});
