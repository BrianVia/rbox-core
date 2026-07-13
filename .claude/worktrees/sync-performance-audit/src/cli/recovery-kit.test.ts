import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  KIT_BANNER,
  kitFileName,
  kitTargetDir,
  readRecoveryKitRecord,
  recoveryKitAction,
  recoveryKitFileState,
  recoveryKitOptionsFromFlags,
  recoveryKitRecordPath,
  renderKit,
  writeRecoveryKit,
} from "./recovery-kit.js";

const ACCOUNT = "acct_0123456789abcdef";
const DATE = new Date(2026, 6, 3, 9, 8, 7);
const PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-kit-"));
  process.env.RBOX_HOME = tmp;
});

afterEach(async () => {
  delete process.env.RBOX_HOME;
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
    expect(record).toEqual({ path: file, writtenAt: DATE.toISOString() });
    expect((await fs.stat(recoveryKitRecordPath(ACCOUNT))).mode & 0o777).toBe(0o600);
    expect(await recoveryKitFileState(record!)).toBe("present");
  });

  test("status detects missing and replaced kit files", async () => {
    const file = path.join(tmp, "kit.txt");
    await writeRecoveryKit(PHRASE, { accountId: ACCOUNT }, file, DATE);
    const record = (await readRecoveryKitRecord(ACCOUNT))!;

    await fs.writeFile(file, "not a kit\n", { mode: 0o600 });
    expect(await recoveryKitFileState(record)).toBe("unrecognized");

    await fs.rm(file);
    expect(await recoveryKitFileState(record)).toBe("missing");
  });

  test("writer refuses an existing symlink target", async () => {
    const target = path.join(tmp, "target.txt");
    const link = path.join(tmp, "link.txt");
    await fs.writeFile(target, "old");
    await fs.symlink(target, link);
    await expect(writeRecoveryKit(PHRASE, { accountId: ACCOUNT }, link, DATE)).rejects.toThrow(/symlink/);
  });
});
