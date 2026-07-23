import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LockIdentitySource } from "../engine/git/lockfile.js";
import {
  generateLoginAttemptKeys,
  LoginAttemptAccountClaimedError,
  loadLoginAttempt,
  loginAttemptKeys,
  loginAttemptPath,
  loginAttemptRoot,
  loginPublicKeyFingerprint,
  requestIdForDeviceCode,
  reserveLoginCredential,
  resumeLoginAttempt,
  stageLoginAttempt,
  sweepLoginAttempts,
  type LoginAttemptOwner,
} from "./login-attempt-journal.js";
import { toB64url } from "../engine/e2ee/index.js";

const REMOTE = "https://api.test";
const LABEL = "new-laptop";
const CODE_A = "a".repeat(64);
const CODE_B = "b".repeat(64);
const OLD_OWNER: LoginAttemptOwner = {
  hostId: "host",
  bootId: "boot",
  pid: 111,
  startTime: "1",
  nonce: "1".repeat(32),
};
const RESTART_IDENTITY: LockIdentitySource = {
  current: async () => ({ hostId: "host", bootId: "boot", pid: 222, startTime: "2" }),
  probe: async () => ({ status: "dead" }),
};

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-login-attempt-"));
  process.env.RBOX_HOME = root;
});

afterEach(async () => {
  delete process.env.RBOX_HOME;
  await fs.rm(root, { recursive: true, force: true });
});

async function stage(
  deviceCode: string,
  createdAt = 1_000,
  expiresAt = 11_000,
  owner = OLD_OWNER,
) {
  return stageLoginAttempt({
    deviceCode,
    userCode: "ABCD-EFGH",
    remoteUrl: REMOTE,
    label: LABEL,
    pollIntervalSeconds: 1,
    createdAt,
    expiresAt,
    keys: generateLoginAttemptKeys(),
    owner,
  });
}

describe("design-189 login attempt journal", () => {
  test("staged keypairs survive a simulated restart and are claimed without regeneration", async () => {
    const staged = await stage(CODE_A);
    const before = loginAttemptKeys(staged);
    const resumed = await resumeLoginAttempt(REMOTE, LABEL, {
      identity: RESTART_IDENTITY,
      now: () => 2_000,
    });
    expect(resumed?.requestId).toBe(await requestIdForDeviceCode(CODE_A));
    expect(resumed?.owner.pid).toBe(222);
    expect(resumed?.owner.nonce).not.toBe(staged.owner.nonce);
    const after = loginAttemptKeys(resumed!);
    expect(Buffer.from(after.sigPrivPkcs8)).toEqual(Buffer.from(before.sigPrivPkcs8));
    expect(Buffer.from(after.encPrivPkcs8)).toEqual(Buffer.from(before.encPrivPkcs8));
    expect((await fs.stat(loginAttemptPath(staged.requestId))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(loginAttemptRoot())).mode & 0o777).toBe(0o700);
  });

  test("concurrent attempts are isolated by sha256(deviceCode)", async () => {
    const first = await stage(CODE_A);
    const second = await stage(CODE_B, 1_001, 11_001, { ...OLD_OWNER, nonce: "2".repeat(32) });
    expect(first.requestId).not.toBe(second.requestId);
    expect(loginAttemptPath(first.requestId)).not.toBe(loginAttemptPath(second.requestId));
    expect(toB64url(loginAttemptKeys(first).encPrivPkcs8))
      .not.toBe(toB64url(loginAttemptKeys(second).encPrivPkcs8));
    expect((await loadLoginAttempt(first.requestId))?.phase).toBe("staged");
    expect((await loadLoginAttempt(second.requestId))?.phase).toBe("staged");
  });

  test("only one concurrent attempt may reserve a machine credential for an account", async () => {
    const first = await stage(CODE_A);
    const second = await stage(CODE_B, 1_001, 11_001, { ...OLD_OWNER, nonce: "2".repeat(32) });
    await reserveLoginCredential(first, "acct_1891891891891891", "dev_first");
    await expect(reserveLoginCredential(second, "acct_1891891891891891", "dev_second"))
      .rejects.toBeInstanceOf(LoginAttemptAccountClaimedError);
    expect((await loadLoginAttempt(second.requestId))?.phase).toBe("staged");
  });

  test("same-host reboot proves the old owner dead and permits exact-key resume", async () => {
    const staged = await stage(CODE_A);
    const rebooted: LockIdentitySource = {
      current: async () => ({ hostId: "host", bootId: "next-boot", pid: 111, startTime: "1" }),
      probe: async () => ({ status: "unknown" }),
    };
    const resumed = await resumeLoginAttempt(REMOTE, LABEL, {
      identity: rebooted,
      now: () => 2_000,
    });
    expect(resumed?.requestId).toBe(staged.requestId);
    expect(Buffer.from(loginAttemptKeys(resumed!).sigPrivPkcs8))
      .toEqual(Buffer.from(loginAttemptKeys(staged).sigPrivPkcs8));
  });

  test("TTL sweep durably abandons and scrubs expired attempts without touching live siblings", async () => {
    const expired = await stage(CODE_A, 1_000, 2_000);
    const live = await stage(CODE_B, 1_000, 20_000, { ...OLD_OWNER, nonce: "2".repeat(32) });
    expect(await sweepLoginAttempts(3_000)).toEqual({ abandoned: 1, removed: 0 });
    const tombstone = await loadLoginAttempt(expired.requestId);
    expect(tombstone?.phase).toBe("abandoned");
    const raw = await fs.readFile(loginAttemptPath(expired.requestId), "utf8");
    expect(raw).not.toContain("deviceCode");
    expect(raw).not.toContain("PrivPkcs8");
    expect((await loadLoginAttempt(live.requestId))?.phase).toBe("staged");
  });

  test("fingerprint uses the exact wire JCS member names and canonical generated keys", async () => {
    const keys = generateLoginAttemptKeys();
    const encPubKey = toB64url(keys.encPubKeySpki);
    const sigPubKey = toB64url(keys.sigPubKey);
    const fingerprint = await loginPublicKeyFingerprint({ encPubKey, sigPubKey });
    expect(fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(loginPublicKeyFingerprint({
      encPubKey,
      sigPubKey: `${sigPubKey}=`,
    })).rejects.toThrow("canonical base64url");
  });
});
