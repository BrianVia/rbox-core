import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bootstrapAccount, toB64url, utf8 } from "../engine/e2ee/index.js";
import { materializeAgentKey, materializeCmd, decodeAgentKeyBundle } from "./key-cmd.js";

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
});

function bundle(raw: object): string {
  return toB64url(utf8(JSON.stringify(raw)));
}

describe("rbox key materialize", () => {
  test("RBOX_KEY bundle decodes and materializes keystore files with private modes", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-key-"));
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
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
