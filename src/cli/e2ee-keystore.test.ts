import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enrolledDeviceId, forgetRecoveryKey, hasDevice, loadDevice, loadRecoveryKey, loadWsKek, saveDevice, saveMasterKey, saveRecoveryKey, saveWsKek } from "./e2ee-keystore.js";
import { bootstrapAccount, generateWorkspaceKek, toB64url } from "../engine/e2ee/index.js";

let tmp: string;
let savedRboxHome: string | undefined;
beforeAll(async () => {
  savedRboxHome = process.env.RBOX_HOME;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-ks-"));
  process.env.RBOX_HOME = tmp;
});
afterAll(async () => {
  if (savedRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = savedRboxHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("e2ee keystore", () => {
  test("device + MK round-trip; files are mode 600", async () => {
    const boot = await bootstrapAccount("acct_ks", "devA", 1_900_000_000_000);
    expect(await hasDevice("acct_ks")).toBe(false);
    await saveDevice(boot.secrets);
    expect(await hasDevice("acct_ks")).toBe(true);

    const loaded = await loadDevice("acct_ks");
    expect(loaded && "secrets" in loaded).toBe(true);
    const secrets = (loaded as { secrets: typeof boot.secrets }).secrets;
    expect(secrets.deviceId).toBe("devA");
    expect(toB64url(secrets.mk)).toBe(toB64url(boot.secrets.mk));
    expect(toB64url(secrets.sigPrivPkcs8)).toBe(toB64url(boot.secrets.sigPrivPkcs8));

    const st = await fs.stat(path.join(tmp, ".rbox", "e2ee", "acct_ks", "mk.key"));
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("partial state (device.json without mk.key) is reported, not crashed (C10)", async () => {
    const boot = await bootstrapAccount("acct_partial", "devB", 1_900_000_000_000);
    await saveDevice(boot.secrets);
    await fs.rm(path.join(tmp, ".rbox", "e2ee", "acct_partial", "mk.key"));
    const loaded = await loadDevice("acct_partial");
    expect(loaded && "device" in loaded && !("secrets" in loaded)).toBe(true);
    // re-deriving MK (e.g. from the server wrap) and saving it restores full state
    await saveMasterKey("acct_partial", boot.secrets.mk);
    expect((await loadDevice("acct_partial")) as { secrets: unknown }).toHaveProperty("secrets");
  });

  test("missing account → undefined", async () => {
    expect(await loadDevice("nope")).toBeUndefined();
    expect(await hasDevice("nope")).toBe(false);
  });

  test("enrolled device id reads the authoritative identity", async () => {
    const boot = await bootstrapAccount("acct_identity", "dev_identity", 1_900_000_000_000);
    expect(await enrolledDeviceId(undefined)).toBeUndefined();
    expect(await enrolledDeviceId("acct_absent")).toBeUndefined();
    await saveDevice(boot.secrets);
    expect(await enrolledDeviceId("acct_identity")).toBe("dev_identity");
  });

  test("workspace KEK cache is per-epoch", async () => {
    const k0 = generateWorkspaceKek();
    const k1 = generateWorkspaceKek();
    await saveWsKek("acct_ks", "ws1", 0, k0);
    await saveWsKek("acct_ks", "ws1", 1, k1);
    expect(toB64url((await loadWsKek("acct_ks", "ws1", 0))!)).toBe(toB64url(k0));
    expect(toB64url((await loadWsKek("acct_ks", "ws1", 1))!)).toBe(toB64url(k1));
    expect(await loadWsKek("acct_ks", "ws1", 2)).toBeUndefined();
  });

  test("recovery key is opt-in and forgettable (C9)", async () => {
    expect(await loadRecoveryKey("acct_ks")).toBeUndefined(); // not cached by default
    const rk = generateWorkspaceKek();
    await saveRecoveryKey("acct_ks", rk);
    expect(toB64url((await loadRecoveryKey("acct_ks"))!)).toBe(toB64url(rk));
    await forgetRecoveryKey("acct_ks");
    expect(await loadRecoveryKey("acct_ks")).toBeUndefined();
  });
});
