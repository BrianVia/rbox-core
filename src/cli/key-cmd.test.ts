import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bootstrapAccount, toB64url, utf8 } from "../engine/e2ee/index.js";
import { createCiKey, materializeCmd } from "./key-cmd.js";
import { materializeAgentKey, decodeAgentKeyBundle } from "./agent-key-bundle.js";
import { saveCredentials } from "./credentials.js";
import { GENESIS_PENDING_MESSAGE, publishPrepublishMarker } from "./genesis-durable.js";
import { withInteractionPolicy } from "./prompt-policy.js";

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
});

function bundle(raw: object): string {
  return toB64url(utf8(JSON.stringify(raw)));
}

describe("rbox key materialize", () => {
  test("rejects when no key input is provided", async () => {
    delete process.env.RBOX_KEY;
    await expect(materializeCmd({})).rejects.toThrow(
      "no key provided — set RBOX_KEY, pass --key-file <path>, or pipe the bundle with --key -"
    );
  });

  test("RBOX_KEY bundle decodes and materializes keystore files with private modes", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-key-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-key-home-"));
    process.env.HOME = home;
    const boot = await bootstrapAccount("acct_agentmat", "agent_devmat", 1_900_000_000_000);
    const mkB64 = toB64url(boot.secrets.mk);
    const raw = bundle({
      v: 1,
      kind: "agent",
      bearer: "rbox_pat_testBearer",
      accountId: boot.secrets.accountId,
      deviceId: boot.secrets.deviceId,
      device: {
        sigPubKey: toB64url(boot.secrets.sigPubKey),
        sigPrivPkcs8: toB64url(boot.secrets.sigPrivPkcs8),
        encPubSpki: toB64url(boot.secrets.encPubSpki),
        encPrivPkcs8: toB64url(boot.secrets.encPrivPkcs8),
      },
      mk: mkB64,
      keks: [{ workspaceId: "ws_agentmat", keyEpoch: 0, kek: toB64url(new Uint8Array(32).fill(3)) }],
    });

    expect(decodeAgentKeyBundle(raw).deviceId).toBe("agent_devmat");
    const out = await materializeAgentKey(raw, { dir: tmp });
    expect(out).toMatchObject({ home: tmp, token: "rbox_pat_testBearer", accountId: "acct_agentmat", deviceId: "agent_devmat" });
    await expect(fs.stat(path.join(home, ".rbox", "credentials.json"))).rejects.toThrow();

    const acctDir = path.join(tmp, ".rbox", "e2ee", "acct_agentmat");
    expect((await fs.stat(acctDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(acctDir, "device.json"))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(acctDir, "mk.key"))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(acctDir, "ws", "ws_agentmat.json"))).mode & 0o777).toBe(0o600);

    process.env.RBOX_KEY = raw;
    const lines: string[] = [];
    const oldLog = console.log;
    console.log = (line?: unknown) => void lines.push(String(line ?? ""));
    try {
      await materializeCmd({ dir: tmp });
    } finally {
      console.log = oldLog;
    }
    const printed = lines.join("\n");
    expect(printed).toContain("export RBOX_HOME=");
    expect(printed).toContain("export RBOX_TOKEN=");
    expect(printed).toContain("export RBOX_ACCOUNT_ID=");
    expect(printed).toContain("export RBOX_DEVICE_ID=");
    expect(printed).not.toContain(mkB64);
    await expect(fs.stat(path.join(home, ".rbox", "credentials.json"))).rejects.toThrow();
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  test("reads a bundle from --key-file", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-key-file-"));
    const boot = await bootstrapAccount("acct_agentfile", "agent_devfile", 1_900_000_000_000);
    const raw = bundle({
      v: 1,
      kind: "agent",
      bearer: "rbox_pat_fileBearer",
      accountId: boot.secrets.accountId,
      deviceId: boot.secrets.deviceId,
      device: {
        sigPubKey: toB64url(boot.secrets.sigPubKey),
        sigPrivPkcs8: toB64url(boot.secrets.sigPrivPkcs8),
        encPubSpki: toB64url(boot.secrets.encPubSpki),
        encPrivPkcs8: toB64url(boot.secrets.encPrivPkcs8),
      },
      mk: toB64url(boot.secrets.mk),
      keks: [],
    });
    const keyFile = path.join(tmp, "bundle.txt");
    const target = path.join(tmp, "target");
    await fs.writeFile(keyFile, raw);
    const oldLog = console.log;
    console.log = () => {};
    try {
      await materializeCmd({ "key-file": keyFile, dir: target });
    } finally {
      console.log = oldLog;
    }
    expect((await fs.stat(path.join(target, ".rbox", "e2ee", "acct_agentfile", "mk.key"))).mode & 0o777).toBe(0o600);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

test("whole rbox key create-ci command gates pending genesis before device or API-key mutation", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-key-pending-"));
  const accountId = "acct_aaaaaaaaaaaaaaaa";
  process.env.RBOX_HOME = tmp;
  process.env.HOME = tmp;
  try {
    await saveCredentials({ token: "tok", deviceId: "dev_pending", remoteUrl: "https://api.test", accountId });
    await publishPrepublishMarker({
      version: 1,
      accountId,
      deviceId: "dev_pending",
      repairId: null,
      startedAt: "2026-07-22T12:00:00.000Z",
      phase: "prepublish",
    });

    await expect(createCiKey({ "accept-root-key": "true", expires: "1d" })).rejects.toThrow(GENESIS_PENDING_MESSAGE);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("revoke gates like create-ci: no destructive call without --yes (#513)", async () => {
  const { revokeKey } = await import("./key-cmd.js");
  const { revokeDevice } = await import("./auth/device-commands.js");
  // Both refuse BEFORE loading credentials or reaching the API.
  await expect(withInteractionPolicy({ enabled: false }, () => revokeKey("dev_agent_x")))
    .rejects.toThrow("refusing to revoke an agent key without --yes in non-interactive mode");
  await expect(withInteractionPolicy({ enabled: false }, () => revokeDevice("dev_x")))
    .rejects.toThrow("refusing to revoke a device without --yes in non-interactive mode");
});

test("rbox key create-ci preserves the exact non-interactive root-key refusal", async () => {
  await expect(withInteractionPolicy(
    { enabled: false },
    () => createCiKey({ expires: "1d" }),
  )).rejects.toThrow(
    "refusing to create an account-root key without --accept-root-key in non-interactive mode",
  );
});
