import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  KIT_BANNER,
  kitFileName,
  kitTargetDir,
  installRecoveryKitWriteTestHook,
  parseRecoveryKitRecord,
  pathIsInsideRemovalRoot,
  claimRecoveryKitOffer,
  invalidateOnePasswordArtifact,
  MAX_ONE_PASSWORD_ARTIFACTS,
  onePasswordArtifactStatuses,
  readRecoveryKitRecord,
  readRecoveryKitRecordState,
  recoveryKitSafety,
  recoveryKitAction,
  recoveryKitFileState,
  recoveryKitOptionsFromFlags,
  recoveryKitRecordPath,
  recordOnePasswordArtifact,
  renderKit,
  writeRecoveryKit,
} from "./recovery-kit.js";

const ACCOUNT = "acct_0123456789abcdef";
const DATE = new Date(2026, 6, 3, 9, 8, 7);
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const ONE_PASSWORD_ARTIFACT = {
  rboxAccountId: ACCOUNT,
  accountUuid: "op_account_1",
  vaultUuid: "op_vault_1",
  itemUuid: "op_item_1",
  fieldId: "rboxRecoveryPhrase" as const,
  operationTag: "rbox-recovery-operation_1",
  writtenAt: DATE.toISOString(),
  state: "active" as const,
};

let tmp: string;
let restoreWriteHook: (() => void) | undefined;
let savedRboxHome: string | undefined;

beforeEach(async () => {
  savedRboxHome = process.env.RBOX_HOME;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-kit-"));
  process.env.RBOX_HOME = tmp;
});

afterEach(async () => {
  restoreWriteHook?.();
  restoreWriteHook = undefined;
  if (savedRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = savedRboxHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("recovery kit", () => {
  test("filename uses the full 16-hex account suffix and local date", () => {
    expect(kitFileName(ACCOUNT, DATE)).toBe("rbox-recovery-kit-0123456789abcdef-20260703.txt");
  });

  test("target dir prefers Downloads only when it exists", () => {
    expect(kitTargetDir({ homeDir: "/home/alice", downloadsExists: true })).toBe("/home/alice/Downloads");
    expect(kitTargetDir({ homeDir: "/home/alice", downloadsExists: false })).toBe("/home/alice");
  });

  test("rendered kit includes account, phrase, recovery steps, and warnings", () => {
    const body = renderKit({ accountId: ACCOUNT, deviceId: "devA", phrase: PHRASE, hostname: "laptop", generatedAt: DATE });
    expect(body.startsWith(`${KIT_BANNER}\n`)).toBe(true);
    expect(body).toContain(`Account: ${ACCOUNT}`);
    expect(body).toContain("Device: laptop (devA)");
    expect(body).toContain(PHRASE);
    expect(body).toContain("rbox key recover");
    expect(body).toContain("Anyone with this phrase can decrypt your rbox data.");
    expect(body).toContain("rbox has no escrow and can never reset this phrase for you.");
  });

  test("flag parsing splits --kit and --kit-path", () => {
    expect(recoveryKitOptionsFromFlags({})).toEqual({ kit: false });
    expect(recoveryKitOptionsFromFlags({ kit: "true" })).toEqual({ kit: true });
    expect(recoveryKitOptionsFromFlags({ "kit-path": "/tmp/kit.txt" })).toEqual({ kit: true, kitPath: "/tmp/kit.txt" });
    expect(() => recoveryKitOptionsFromFlags({ kit: "/tmp/kit.txt" })).toThrow(/--kit/);
    expect(() => recoveryKitOptionsFromFlags({ "kit-path": "true" })).toThrow(/--kit-path/);
  });

  test("non-interactive default takes no kit path", () => {
    expect(recoveryKitAction(false, { kit: false })).toBe("none");
    expect(recoveryKitAction(false, { kit: true })).toBe("write-suppress-echo");
  });

  test("writer stores kit and kit.json with 0600 modes", async () => {
    const file = path.join(tmp, "kit.txt");
    const written = await writeRecoveryKit(PHRASE, { accountId: ACCOUNT, deviceId: "devA" }, file, DATE);
    expect(written.path).toBe(file);
    expect(written.recordError).toBeUndefined();

    const body = await fs.readFile(file, "utf8");
    expect(body).toContain(PHRASE);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    const record = await readRecoveryKitRecord(ACCOUNT);
    expect(record).toEqual({
      version: 3,
      accountId: ACCOUNT,
      plaintextArtifacts: [{ path: file, writtenAt: DATE.toISOString(), cleanup: "pending" }],
      onePasswordArtifacts: [],
    });
    expect((await fs.stat(recoveryKitRecordPath(ACCOUNT))).mode & 0o777).toBe(0o600);
    expect(await recoveryKitFileState(ACCOUNT, record!.plaintextArtifacts[0])).toBe("present");
  });

  test("the plaintext kit success line says PLAIN TEXT (help promises the Keychain)", async () => {
    const { writeKitSuccess } = await import("./auth/recovery-kit-flow.js");
    const file = path.join(tmp, "kit.txt");
    const origWrite = process.stderr.write.bind(process.stderr);
    let err = "";
    process.stderr.write = ((s: string | Uint8Array) => { err += String(s); return true }) as typeof process.stderr.write;
    try {
      // --kit-path takes the plaintext branch on every platform, darwin included.
      await writeKitSuccess(PHRASE, { accountId: ACCOUNT }, { kit: true, kitPath: file }, false);
      await writeKitSuccess(PHRASE, { accountId: ACCOUNT }, { kit: true, kitPath: file }, true);
    } finally {
      process.stderr.write = origWrite;
    }
    expect(err).toContain("plain text");
    expect(err).toContain("written in plain text to");
  });

  test("status detects missing and replaced kit files", async () => {
    const file = path.join(tmp, "kit.txt");
    await writeRecoveryKit(PHRASE, { accountId: ACCOUNT }, file, DATE);
    const record = (await readRecoveryKitRecord(ACCOUNT))!;

    await fs.writeFile(file, "not a kit\n", { mode: 0o600 });
    expect(await recoveryKitFileState(ACCOUNT, record.plaintextArtifacts[0])).toBe("unrecognized");

    await fs.rm(file);
    expect(await recoveryKitFileState(ACCOUNT, record.plaintextArtifacts[0])).toBe("missing");
  });

  test("plaintext probes bind every artifact to the current account", async () => {
    const file = path.join(tmp, "cross-account.txt");
    await fs.writeFile(file, renderKit({ accountId: "acct_ffffffffffffffff", phrase: PHRASE, hostname: "other", generatedAt: DATE }), { mode: 0o600 });
    expect(await recoveryKitFileState(ACCOUNT, { path: file, writtenAt: DATE.toISOString(), cleanup: "pending" })).toBe("unrecognized");
  });

  test("record paths reject malformed accounts before interpolation and stay in the exact account directory", () => {
    expect(() => recoveryKitRecordPath("acct_../escape")).toThrow(/malformed account id/);
    expect(() => recoveryKitRecordPath("acct_A123456789abcdef")).toThrow(/malformed account id/);
    const record = recoveryKitRecordPath(ACCOUNT);
    expect(record).toBe(path.join(tmp, ".rbox", "e2ee", ACCOUNT, "kit.json"));
    expect(path.dirname(record)).toBe(path.join(tmp, ".rbox", "e2ee", ACCOUNT));
  });

  test("writer refuses an existing symlink target", async () => {
    const target = path.join(tmp, "target.txt");
    const link = path.join(tmp, "link.txt");
    await fs.writeFile(target, "old");
    await fs.symlink(target, link);
    await expect(writeRecoveryKit(PHRASE, { accountId: ACCOUNT }, link, DATE)).rejects.toThrow(/symlink/);
  });

  test("strict parser normalizes only the exact legacy shape and rejects unknown or mixed records", () => {
    expect(parseRecoveryKitRecord({ path: "/tmp/kit", writtenAt: DATE.toISOString() }, ACCOUNT)).toEqual({
      version: 3,
      accountId: ACCOUNT,
      plaintextArtifacts: [{ path: "/tmp/kit", writtenAt: DATE.toISOString(), cleanup: "pending" }],
      onePasswordArtifacts: [],
    });
    expect(parseRecoveryKitRecord({ path: "/tmp/kit", writtenAt: DATE.toISOString(), extra: true }, ACCOUNT)).toBeUndefined();
    expect(parseRecoveryKitRecord({ version: 3, accountId: ACCOUNT, plaintextArtifacts: [] }, ACCOUNT)).toBeUndefined();
    expect(parseRecoveryKitRecord({ version: 2, accountId: "acct_ffffffffffffffff", plaintextArtifacts: [] }, ACCOUNT)).toBeUndefined();
    expect(parseRecoveryKitRecord({ version: 2, accountId: ACCOUNT, plaintextArtifacts: [], path: "/tmp/legacy" }, ACCOUNT)).toBeUndefined();
  });

  test("strictly migrates recognized v2 records to v3 without changing their evidence", () => {
    const v2 = {
      version: 2,
      accountId: ACCOUNT,
      keychain: { service: "rbox recovery phrase", account: ACCOUNT, keychainPath: "/Users/a/login.keychain-db", writtenAt: DATE.toISOString() },
      plaintextArtifacts: [{ path: "/tmp/kit", writtenAt: DATE.toISOString(), cleanup: "declined" }],
      offer: { claimedAt: DATE.toISOString(), surface: "login", phraseSource: "typed", outcome: "accepted" },
    };
    expect(parseRecoveryKitRecord(v2, ACCOUNT)).toEqual({
      ...v2,
      version: 3,
      onePasswordArtifacts: [],
    });
  });

  test("v3 parser enforces exact 1Password locators, bounds, account binding, and deduplication", () => {
    const base = { version: 3, accountId: ACCOUNT, plaintextArtifacts: [], onePasswordArtifacts: [ONE_PASSWORD_ARTIFACT] };
    expect(parseRecoveryKitRecord(base, ACCOUNT)?.onePasswordArtifacts).toEqual([ONE_PASSWORD_ARTIFACT]);
    expect(parseRecoveryKitRecord({
      ...base,
      onePasswordArtifacts: [{ ...ONE_PASSWORD_ARTIFACT, fieldId: "notesPlain" }],
    }, ACCOUNT)).toBeUndefined();
    expect(parseRecoveryKitRecord({
      ...base,
      onePasswordArtifacts: [{ ...ONE_PASSWORD_ARTIFACT, rboxAccountId: "acct_ffffffffffffffff" }],
    }, ACCOUNT)).toBeUndefined();
    expect(parseRecoveryKitRecord({
      ...base,
      onePasswordArtifacts: [ONE_PASSWORD_ARTIFACT, { ...ONE_PASSWORD_ARTIFACT, operationTag: "different" }],
    }, ACCOUNT)).toBeUndefined();
    expect(parseRecoveryKitRecord({
      ...base,
      onePasswordArtifacts: Array.from({ length: MAX_ONE_PASSWORD_ARTIFACTS + 1 }, (_, index) => ({
        ...ONE_PASSWORD_ARTIFACT,
        itemUuid: `item_${index}`,
      })),
    }, ACCOUNT)).toBeUndefined();
    expect(parseRecoveryKitRecord({
      ...base,
      onePasswordArtifacts: [{ ...ONE_PASSWORD_ARTIFACT, operationTag: "bad\ntag" }],
    }, ACCOUNT)).toBeUndefined();
    expect(parseRecoveryKitRecord({
      ...base,
      onePasswordArtifacts: [{ ...ONE_PASSWORD_ARTIFACT, extra: true }],
    }, ACCOUNT)).toBeUndefined();
  });

  test("records active 1Password locators and durably invalidates the exact locator", async () => {
    expect(await recordOnePasswordArtifact(ACCOUNT, ONE_PASSWORD_ARTIFACT)).toBe("recorded");
    expect(await recordOnePasswordArtifact(ACCOUNT, ONE_PASSWORD_ARTIFACT)).toBe("unchanged");
    let record = (await readRecoveryKitRecord(ACCOUNT))!;
    expect(onePasswordArtifactStatuses(record)).toEqual([{ ...ONE_PASSWORD_ARTIFACT, status: "recorded" }]);

    const invalidatedAt = new Date("2026-07-23T15:00:00.000Z");
    expect(await invalidateOnePasswordArtifact(ACCOUNT, ONE_PASSWORD_ARTIFACT, "missing", invalidatedAt)).toBe("invalidated");
    expect(await invalidateOnePasswordArtifact(ACCOUNT, ONE_PASSWORD_ARTIFACT, "missing", invalidatedAt)).toBe("unchanged");
    record = (await readRecoveryKitRecord(ACCOUNT))!;
    expect(onePasswordArtifactStatuses(record)).toEqual([{
      ...ONE_PASSWORD_ARTIFACT,
      state: "invalidated",
      invalidatedAt: invalidatedAt.toISOString(),
      invalidationReason: "missing",
      status: "invalidated",
    }]);
    await expect(invalidateOnePasswordArtifact(ACCOUNT, { ...ONE_PASSWORD_ARTIFACT, operationTag: "wrong" }, "missing")).rejects.toThrow(/does not match/);
  });

  test("re-recording the same active 1Password item with a drifted writtenAt is idempotent (crash-resume)", async () => {
    // Regression: a crash between the provider write and the durable progress
    // append re-records the same verified item on resume, but with a freshly
    // sampled writtenAt. That used to throw "conflicting 1Password artifact
    // identity" and wedge the destination forever. It must be idempotent and keep
    // the original record.
    expect(await recordOnePasswordArtifact(ACCOUNT, ONE_PASSWORD_ARTIFACT)).toBe("recorded");
    expect(await recordOnePasswordArtifact(ACCOUNT, { ...ONE_PASSWORD_ARTIFACT, writtenAt: "2026-07-23T16:30:00.000Z" })).toBe("unchanged");
    const record = (await readRecoveryKitRecord(ACCOUNT))!;
    expect(record.onePasswordArtifacts).toHaveLength(1);
    expect(record.onePasswordArtifacts[0]!.writtenAt).toBe(ONE_PASSWORD_ARTIFACT.writtenAt);
  });

  test("conflicting stable 1Password identities and full bounded history fail closed", async () => {
    await recordOnePasswordArtifact(ACCOUNT, ONE_PASSWORD_ARTIFACT);
    await expect(recordOnePasswordArtifact(ACCOUNT, { ...ONE_PASSWORD_ARTIFACT, operationTag: "different" })).rejects.toThrow(/conflicting/);
    for (let index = 1; index < MAX_ONE_PASSWORD_ARTIFACTS; index++) {
      await recordOnePasswordArtifact(ACCOUNT, { ...ONE_PASSWORD_ARTIFACT, itemUuid: `op_item_${index + 1}`, operationTag: `operation_${index + 1}` });
    }
    await expect(recordOnePasswordArtifact(ACCOUNT, {
      ...ONE_PASSWORD_ARTIFACT,
      itemUuid: "op_item_overflow",
      operationTag: "operation_overflow",
    })).rejects.toThrow(/history is full/);
  });

  test("unknown records are distinguished and never overwritten", async () => {
    await fs.mkdir(path.dirname(recoveryKitRecordPath(ACCOUNT)), { recursive: true });
    await fs.writeFile(recoveryKitRecordPath(ACCOUNT), '{"version":99}\n');
    expect(await readRecoveryKitRecordState(ACCOUNT)).toEqual({ state: "unknown" });
    const file = path.join(tmp, "new-kit.txt");
    const write = await writeRecoveryKit(PHRASE, { accountId: ACCOUNT }, file, DATE);
    expect(write.recordError?.message).toContain("unknown");
    expect(await fs.readFile(recoveryKitRecordPath(ACCOUNT), "utf8")).toBe('{"version":99}\n');
  });

  test("containment uses a separator boundary", () => {
    expect(pathIsInsideRemovalRoot("/tmp/rbox/e2ee/kit", "/tmp/rbox")).toBe(true);
    expect(pathIsInsideRemovalRoot("/tmp/rbox-other/kit", "/tmp/rbox")).toBe(false);
  });

  test("uninstall safety gives surviving present evidence precedence and never treats unavailable as safe", () => {
    const record = parseRecoveryKitRecord({
      version: 2,
      accountId: ACCOUNT,
      keychain: { service: "rbox recovery phrase", account: ACCOUNT, keychainPath: "/Users/a/login.keychain-db", writtenAt: DATE.toISOString() },
      plaintextArtifacts: [{ path: "/tmp/rbox/inside.txt", writtenAt: DATE.toISOString(), cleanup: "declined" }],
    }, ACCOUNT)!;
    const loaded = { state: "recognized" as const, record };
    expect(recoveryKitSafety(loaded, { keychain: "present", plaintext: ["unavailable"] }, "/tmp/rbox")).toBe("backed-up");
    expect(recoveryKitSafety(loaded, { keychain: "missing", plaintext: ["unavailable"] }, "/tmp/rbox")).toBe("unknown");
    expect(recoveryKitSafety(loaded, { keychain: "missing", plaintext: ["present"] }, "/tmp/rbox")).toBe("at-risk");
    expect(recoveryKitSafety({ state: "unknown" }, { plaintext: [] }, "/tmp/rbox")).toBe("unknown");
    expect(recoveryKitSafety({ state: "missing" }, { plaintext: [] }, "/tmp/rbox")).toBe("at-risk");
  });

  test("an unchecked active 1Password locator makes uninstall safety unknown, never backed up", () => {
    const record = parseRecoveryKitRecord({
      version: 3,
      accountId: ACCOUNT,
      plaintextArtifacts: [],
      onePasswordArtifacts: [ONE_PASSWORD_ARTIFACT],
    }, ACCOUNT)!;
    expect(recoveryKitSafety({ state: "recognized", record }, { plaintext: [] }, "/tmp/rbox")).toBe("unknown");
    const invalidated = parseRecoveryKitRecord({
      ...record,
      onePasswordArtifacts: [{
        ...ONE_PASSWORD_ARTIFACT,
        state: "invalidated",
        invalidatedAt: DATE.toISOString(),
        invalidationReason: "mismatch",
      }],
    }, ACCOUNT)!;
    expect(recoveryKitSafety({ state: "recognized", record: invalidated }, { plaintext: [] }, "/tmp/rbox")).toBe("at-risk");
  });

  test("concurrent once-only offer claims have exactly one winner", async () => {
    const results = await Promise.all([
      claimRecoveryKitOffer(ACCOUNT, "status", "cached-rk", async () => true, DATE),
      claimRecoveryKitOffer(ACCOUNT, "login", "typed", async () => true, DATE),
    ]);
    expect(results.sort()).toEqual([false, true]);
    const record = await readRecoveryKitRecord(ACCOUNT);
    expect(record?.offer?.outcome).toBe("claimed");
  });

  test("a concurrent claim waits beyond the former short retry window", async () => {
    let releasePreflight!: () => void;
    const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve });
    let enteredPreflight!: () => void;
    const preflightEntered = new Promise<void>((resolve) => { enteredPreflight = resolve });
    const winner = claimRecoveryKitOffer(ACCOUNT, "status", "cached-rk", async () => {
      enteredPreflight();
      await preflightGate;
      return true;
    }, DATE);
    await preflightEntered;
    const loser = claimRecoveryKitOffer(ACCOUNT, "login", "typed", async () => true, DATE);
    await new Promise((resolve) => setTimeout(resolve, 600));
    releasePreflight();
    expect(await Promise.all([winner, loser])).toEqual([true, false]);
  });

  test("non-actionable offer preflights do not consume the once-only claim", async () => {
    expect(await claimRecoveryKitOffer(ACCOUNT, "status", "cached-rk", async () => false, DATE)).toBe(false);
    expect((await readRecoveryKitRecordState(ACCOUNT)).state).toBe("missing");
    await expect(claimRecoveryKitOffer(ACCOUNT, "status", "cached-rk", async () => { throw new Error("probe unavailable") }, DATE)).rejects.toThrow(/probe unavailable/);
    expect((await readRecoveryKitRecordState(ACCOUNT)).state).toBe("missing");
  });

  test("hardened publication exposes and fails closed at every governed stage", async () => {
    const stages = [
      "before-temp-parent-check", "atomic-temp-opened", "atomic-temp-written", "atomic-temp-synced", "atomic-temp-closed",
      "before-rename-parent-check", "atomic-before-rename", "atomic-after-rename", "before-readback", "after-readback",
      "after-published-fsync", "after-directory-fsync",
    ] as const;
    for (const surface of ["plaintext", "locator"] as const) {
      for (const [index, failedStage] of stages.entries()) {
        process.env.RBOX_HOME = path.join(tmp, `${surface}-fault-${index}`);
        const file = path.join(tmp, `${surface}-kit-${index}.txt`);
        const locator = recoveryKitRecordPath(ACCOUNT);
        const target = surface === "plaintext" ? file : locator;
        restoreWriteHook = installRecoveryKitWriteTestHook((step, candidate) => {
          if (candidate === target && step === failedStage) throw new Error(`injected ${surface} ${failedStage}`);
        });
        if (surface === "plaintext") {
          await expect(writeRecoveryKit(PHRASE, { accountId: ACCOUNT }, file, DATE)).rejects.toThrow(`injected ${surface} ${failedStage}`);
        } else {
          const written = await writeRecoveryKit(PHRASE, { accountId: ACCOUNT }, file, DATE);
          expect(written.recordError?.message).toContain(`injected ${surface} ${failedStage}`);
        }
        restoreWriteHook();
        restoreWriteHook = undefined;
      }
    }
    process.env.RBOX_HOME = tmp;
  });

  test("parent replacement before temp creation and before rename is rejected by identity", async () => {
    for (const boundary of ["parent-validated", "before-rename-parent-check"] as const) {
      const parent = path.join(tmp, `swap-${boundary}`);
      const displaced = `${parent}-old`;
      const file = path.join(parent, "kit.txt");
      let swapped = false;
      restoreWriteHook = installRecoveryKitWriteTestHook(async (step, candidate) => {
        if (candidate !== file || step !== boundary || swapped) return;
        swapped = true;
        await fs.rename(parent, displaced);
        await fs.mkdir(parent, { mode: 0o700 });
      });
      await expect(writeRecoveryKit(PHRASE, { accountId: ACCOUNT }, file, DATE)).rejects.toThrow(/parent directory changed/);
      expect(swapped).toBe(true);
      await expect(fs.access(file)).rejects.toThrow();
      restoreWriteHook();
      restoreWriteHook = undefined;
    }
  });
});
