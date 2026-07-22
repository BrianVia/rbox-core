import { describe, expect, test } from "bun:test";
import {
  buildSecurityAddInput,
  canonicalRecoveryPhrase,
  probeKeychainKit,
  readKeychainKit,
  resolveLoginKeychain,
  writeKeychainKit,
  type KeychainSeams,
  type SecurityResult,
} from "./recovery-kit-keychain.js";

const ACCOUNT = "acct_0123456789abcdef";
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const KEYCHAIN = "/Users/a/Library/Keychains/login keychain.keychain-db";
const artifact = { service: "rbox recovery phrase" as const, account: ACCOUNT, keychainPath: KEYCHAIN, writtenAt: "2026-07-22T12:00:00.000Z" };

function result(overrides: Partial<SecurityResult> = {}): SecurityResult {
  return { outcome: "exit", code: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), ...overrides };
}

function seams(run: KeychainSeams["runSecurity"]): KeychainSeams {
  return { platform: "darwin", securityBinExists: async () => true, realpath: async (value) => value, runSecurity: run };
}

describe("macOS recovery Keychain", () => {
  test("builds exactly one physical security -i line with one LF and no secret argv", async () => {
    const canonical = await canonicalRecoveryPhrase(PHRASE);
    const input = buildSecurityAddInput(canonical, ACCOUNT, KEYCHAIN);
    const text = Buffer.from(input).toString("utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.slice(0, -1)).not.toContain("\n");
    expect(input.length).toBeLessThan(4096);
    expect(text).toBe(`add-generic-password -U -s \"rbox recovery phrase\" -a \"${ACCOUNT}\" -l \"rbox recovery phrase (0123456789abcdef)\" -j \"24-word rbox recovery phrase. Restore: install rbox, rbox login, rbox key recover.\" -w \"${PHRASE}\" \"${KEYCHAIN}\"\n`);
  });

  test("rejects command injection and malformed identities before spawning", () => {
    expect(() => buildSecurityAddInput(PHRASE, ACCOUNT, "/tmp/a\nadd-generic-password")).toThrow(/path/);
    expect(() => buildSecurityAddInput(PHRASE, "acct_wrong", KEYCHAIN)).toThrow(/account/);
    expect(() => buildSecurityAddInput(`${PHRASE}\nextra`, ACCOUNT, KEYCHAIN)).toThrow(/canonical/);
  });

  test("resolves one explicit login Keychain and canonicalizes it", async () => {
    const calls: readonly string[][] = [];
    const fake = seams(async (args) => {
      (calls as string[][]).push([...args]);
      return result({ stdout: Buffer.from(`\"${KEYCHAIN}\"\n`) });
    });
    expect(await resolveLoginKeychain(fake)).toBe(KEYCHAIN);
    expect(calls).toEqual([["login-keychain", "-d", "user"]]);
  });

  test("add uses stdin only and verification propagates the exact identity", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: Uint8Array }> = [];
    const fake = seams(async (args, stdin) => {
      calls.push({ args, ...(stdin ? { stdin: Uint8Array.from(stdin) } : {}) });
      return args[0] === "-i" ? result() : result({ stdout: Buffer.from(`${PHRASE}\n`) });
    });
    const saved = await writeKeychainKit(PHRASE, ACCOUNT, KEYCHAIN, fake, new Date("2026-07-22T12:00:00.000Z"));
    expect(saved).toEqual(artifact);
    expect(calls[0]!.args).toEqual(["-i"]);
    expect(calls[0]!.stdin).toBeDefined();
    expect(calls[1]!.args).toEqual(["find-generic-password", "-s", "rbox recovery phrase", "-a", ACCOUNT, "-w", KEYCHAIN]);
    expect(calls[1]!.stdin).toBeUndefined();
  });

  test("verification mismatch stores no successful artifact", async () => {
    const fake = seams(async (args) => args[0] === "-i" ? result() : result({ stdout: Buffer.from("wrong\n") }));
    await expect(writeKeychainKit(PHRASE, ACCOUNT, KEYCHAIN, fake)).rejects.toThrow(/mismatch/);
  });

  test("probe classifies only exit 44 as missing", async () => {
    for (const [shape, expected] of [
      [result({ stdout: Buffer.from("keychain: attributes\n") }), "present"],
      [result({ code: 44 }), "missing"],
      [result({ code: 1 }), "unavailable"],
      [result({ outcome: "timeout", code: undefined }), "unavailable"],
      [result({ outcome: "signal", code: undefined, signal: "SIGTERM" }), "unavailable"],
      [result({ outcome: "overflow", code: undefined }), "unavailable"],
      [result({ outcome: "spawn-error", code: undefined }), "unavailable"],
    ] as const) {
      expect(await probeKeychainKit(artifact, seams(async () => shape))).toBe(expected);
    }
  });

  test("read returns secret bytes without one terminal CRLF", async () => {
    const bytes = await readKeychainKit(artifact, seams(async () => result({ stdout: Buffer.from(`${PHRASE}\r\n`) })));
    expect(Buffer.from(bytes).toString("utf8")).toBe(PHRASE);
    bytes.fill(0);
  });
});
