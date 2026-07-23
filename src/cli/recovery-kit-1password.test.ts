import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  attemptOnePasswordRecoverySave,
  createOnePasswordRecoveryItem,
  detectOnePasswordCli,
  listOnePasswordAccounts,
  listOnePasswordVaults,
  minimalOnePasswordEnvironment,
  providerOnePasswordEnvironment,
  reconcileOnePasswordRecoveryItem,
  runOnePasswordProcess,
  verifyOnePasswordRecoveryItem,
  type OnePasswordProcessResult,
  type OnePasswordProvider,
  type RunOnePassword,
} from "./recovery-kit-1password.js";

const ACCOUNT = "acct_0123456789abcdef";
const OP_ACCOUNT = "account_uuid_123";
const VAULT = "vault_uuid_123";
const ITEM = "item_uuid_123";
const TAG = "rbox-recovery-op_123";
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

let tmp: string;
let fakeOp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-op-fake-"));
  fakeOp = path.join(tmp, "op");
  const runtime = process.execPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await fs.writeFile(fakeOp, `#!${runtime}
import fs from "node:fs";
import path from "node:path";
const home = process.env.HOME;
const scenario = JSON.parse(fs.readFileSync(path.join(home, "scenario.json"), "utf8"));
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
fs.appendFileSync(path.join(home, "calls.jsonl"), JSON.stringify({argv: process.argv.slice(2), env: process.env, stdin}) + "\\n");
const argv = process.argv.slice(2);
if (scenario.sleep) await new Promise((resolve) => setTimeout(resolve, scenario.sleep));
let key = "other";
if (argv[0] === "--version") key = "version";
else if (argv[0] === "account") key = "accounts";
else if (argv[0] === "vault") key = "vaults";
else if (argv[0] === "item" && argv[1] === "create") key = "create";
else if (argv[0] === "item" && argv[1] === "list") key = "list";
else if (argv[0] === "read") key = "read";
const response = scenario[key] ?? {};
if (response.stdout !== undefined) process.stdout.write(typeof response.stdout === "string" ? response.stdout : JSON.stringify(response.stdout));
if (response.stderr !== undefined) process.stderr.write(response.stderr);
process.exit(response.code ?? 0);
`);
  await fs.chmod(fakeOp, 0o700);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function scenario(value: unknown): Promise<void> {
  await fs.writeFile(path.join(tmp, "scenario.json"), JSON.stringify(value));
}

async function calls(): Promise<Array<{ argv: string[]; env: Record<string, string>; stdin: string }>> {
  const raw = await fs.readFile(path.join(tmp, "calls.jsonl"), "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function provider(extraEnv: NodeJS.ProcessEnv = {}): OnePasswordProvider {
  return {
    executable: fakeOp,
    env: {
      HOME: tmp,
      PATH: process.env.PATH,
      LANG: "C",
      OP_ACCOUNT: "allowed-account-default",
      OP_SESSION: "allowed-session",
      OP_SESSION_work_2: "allowed-suffixed-session",
      OP_SESSION_bad$: "stripped",
      OP_BIOMETRIC_UNLOCK_ENABLED: "true",
      OP_CONFIG_DIR: "/allowed/op",
      OP_SERVICE_ACCOUNT_TOKEN: "strip-service-token",
      OP_CONNECT_TOKEN: "strip-connect-token",
      OP_DEBUG: "true",
      OP_FORMAT: "yaml",
      RBOX_SECRET: "strip-rbox",
      AWS_SECRET_ACCESS_KEY: "strip-cloud",
      GITHUB_TOKEN: "strip-ci",
      RANDOM_SECRET: "strip-unrelated",
      ...extraEnv,
    },
  };
}

describe("1Password recovery provider", () => {
  test("pre-consent detection accepts only op 2.x and uses the minimal environment", async () => {
    await scenario({ version: { stdout: "2.32.0\n" } });
    const env = provider().env;
    expect(await detectOnePasswordCli({ executable: fakeOp, env })).toEqual({
      state: "available",
      executable: fakeOp,
      version: "2.32.0",
    });
    const [call] = await calls();
    expect(call!.argv).toEqual(["--version"]);
    expect(call!.env.OP_SESSION).toBeUndefined();
    expect(call!.env.OP_ACCOUNT).toBeUndefined();
    expect(call!.env.OP_CONFIG_DIR).toBeUndefined();
    expect(call!.env.HOME).toBe(tmp);

    await scenario({ version: { stdout: "1.12.3\n" } });
    expect(await detectOnePasswordCli({ executable: fakeOp, env })).toEqual({
      state: "unavailable",
      reason: "unsupported-version",
    });
  });

  test("environment builders retain only exact process, locale, and post-consent op keys", () => {
    const source = provider().env;
    expect(minimalOnePasswordEnvironment(source)).toEqual({
      HOME: tmp,
      PATH: process.env.PATH,
      LANG: "C",
    });
    expect(providerOnePasswordEnvironment(source)).toEqual({
      HOME: tmp,
      PATH: process.env.PATH,
      LANG: "C",
      OP_ACCOUNT: "allowed-account-default",
      OP_SESSION: "allowed-session",
      OP_SESSION_work_2: "allowed-suffixed-session",
      OP_BIOMETRIC_UNLOCK_ENABLED: "true",
      OP_CONFIG_DIR: "/allowed/op",
    });
  });

  test("projects accounts and vaults with sanitized, disambiguated labels", async () => {
    await scenario({
      accounts: { stdout: [
        { account_uuid: "account_1", email: "\u001b[31malice@example.com", url: "team.1password.com\nspoof" },
        { account_uuid: "account_2", email: "bob@example.com", url: "work.1password.com" },
        { account_uuid: "account_3", email: "bob@example.com", url: "work.1password.com" },
      ] },
      vaults: { stdout: [
        { id: "vault_1", name: "Personal" },
        { id: "vault_2", name: "Personal" },
      ] },
    });
    const accounts = await listOnePasswordAccounts(provider());
    expect(accounts).toEqual({
      state: "ok",
      accounts: [
        { uuid: "account_1", label: "[31malice@example.com · team.1password.com spoof" },
        { uuid: "account_2", label: "bob@example.com · work.1password.com · account_2" },
        { uuid: "account_3", label: "bob@example.com · work.1password.com · account_3" },
      ],
    });
    const vaults = await listOnePasswordVaults(provider(), OP_ACCOUNT);
    expect(vaults).toEqual({
      state: "ok",
      vaults: [
        { uuid: "vault_1", name: "Personal", label: "Personal · vault_1" },
        { uuid: "vault_2", name: "Personal", label: "Personal · vault_2" },
      ],
    });
    for (const call of await calls()) {
      expect(call.env.OP_SESSION).toBe("allowed-session");
      expect(call.env.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();
      expect(call.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(call.env.RBOX_SECRET).toBeUndefined();
    }
  });

  test("create uses exact shell-free argv and places the phrase only in JSON stdin", async () => {
    await scenario({ create: { stdout: { id: ITEM, vault: { id: VAULT }, fields: [{ value: PHRASE }] } } });
    const outcome = await createOnePasswordRecoveryItem(provider(), {
      accountUuid: OP_ACCOUNT,
      vaultUuid: VAULT,
      operationTag: TAG,
      rboxAccountId: ACCOUNT,
      phrase: PHRASE,
    });
    expect(outcome).toEqual({
      state: "created",
      locator: { accountUuid: OP_ACCOUNT, vaultUuid: VAULT, itemUuid: ITEM, fieldId: "rboxRecoveryPhrase", operationTag: TAG },
    });
    const [call] = await calls();
    expect(call!.argv).toEqual(["item", "create", "--account", OP_ACCOUNT, "--vault", VAULT, "--format=json", "-"]);
    expect(call!.argv.join(" ")).not.toContain(PHRASE);
    expect(Object.values(call!.env).join(" ")).not.toContain(PHRASE);
    const body = JSON.parse(call!.stdin);
    expect(body.tags).toEqual(["rbox", TAG]);
    expect(body.fields[0]).toEqual({ id: "rboxRecoveryPhrase", type: "CONCEALED", label: "Recovery phrase", value: PHRASE });
    expect(body.fields[1].value).toBe(ACCOUNT);
  });

  test("reconciliation post-filters exact tags and rejects multiple matches", async () => {
    await scenario({ list: { stdout: [
      { id: "subtag_item", tags: [`${TAG}/child`] },
      { id: ITEM, tags: ["rbox", TAG] },
    ] } });
    expect(await reconcileOnePasswordRecoveryItem(provider(), {
      accountUuid: OP_ACCOUNT, vaultUuid: VAULT, operationTag: TAG,
    })).toEqual({
      state: "found",
      locator: { accountUuid: OP_ACCOUNT, vaultUuid: VAULT, itemUuid: ITEM, fieldId: "rboxRecoveryPhrase", operationTag: TAG },
    });

    await scenario({ list: { stdout: [
      { id: "item_1", tags: [TAG] },
      { id: "item_2", tags: [TAG] },
    ] } });
    expect((await reconcileOnePasswordRecoveryItem(provider(), {
      accountUuid: OP_ACCOUNT, vaultUuid: VAULT, operationTag: TAG,
    })).state).toBe("ambiguous");
  });

  test("exact readback uses stable UUIDs and distinguishes match from mismatch", async () => {
    const locator = { accountUuid: OP_ACCOUNT, vaultUuid: VAULT, itemUuid: ITEM, fieldId: "rboxRecoveryPhrase" as const, operationTag: TAG };
    await scenario({ read: { stdout: PHRASE } });
    expect(await verifyOnePasswordRecoveryItem(provider(), locator, Buffer.from(PHRASE))).toBe("valid");
    let recorded = await calls();
    expect(recorded[0]!.argv).toEqual(["read", "-n", `op://${VAULT}/${ITEM}/rboxRecoveryPhrase`, "--account", OP_ACCOUNT]);

    await fs.rm(path.join(tmp, "calls.jsonl"));
    await scenario({ read: { stdout: `${PHRASE}x` } });
    expect(await verifyOnePasswordRecoveryItem(provider(), locator, Buffer.from(PHRASE))).toBe("mismatch");
    recorded = await calls();
    expect(recorded[0]!.stdin).toBe("");
  });

  test("attempt reconciles before create and never creates after an ambiguous prior dispatch", async () => {
    await scenario({ list: { stdout: [] }, create: { stdout: { id: ITEM, vault: { id: VAULT } } }, read: { stdout: PHRASE } });
    const base = { accountUuid: OP_ACCOUNT, vaultUuid: VAULT, operationTag: TAG, rboxAccountId: ACCOUNT, phrase: PHRASE };
    expect(await attemptOnePasswordRecoverySave(provider(), { ...base, mayCreate: false })).toEqual({ state: "missing" });
    expect((await calls()).map((call) => call.argv.slice(0, 2))).toEqual([["item", "list"]]);

    await fs.rm(path.join(tmp, "calls.jsonl"));
    expect(await attemptOnePasswordRecoverySave(provider(), { ...base, mayCreate: true })).toMatchObject({ state: "verified", source: "created" });
    expect((await calls()).map((call) => call.argv.slice(0, 2))).toEqual([["item", "list"], ["item", "create"], ["read", "-n"]]);
  });

  test("attempt reconciles again after every ambiguous create outcome", async () => {
    let lists = 0;
    const invoked: string[][] = [];
    const run: RunOnePassword = async (_executable, args) => {
      invoked.push([...args]);
      let stdout: Uint8Array = new Uint8Array();
      let code = 0;
      if (args[0] === "item" && args[1] === "list") {
        lists++;
        stdout = Buffer.from(JSON.stringify(lists === 1 ? [] : [{ id: ITEM, tags: [TAG] }]));
      } else if (args[0] === "item" && args[1] === "create") {
        code = 1;
      } else if (args[0] === "read") {
        stdout = Buffer.from(PHRASE);
      }
      return { outcome: "exit", code, stdout, stderr: new Uint8Array(), childStarted: true };
    };
    const result = await attemptOnePasswordRecoverySave({ ...provider(), run }, {
      accountUuid: OP_ACCOUNT,
      vaultUuid: VAULT,
      operationTag: TAG,
      rboxAccountId: ACCOUNT,
      phrase: PHRASE,
      mayCreate: true,
    });
    expect(result).toMatchObject({ state: "verified", source: "reconciled" });
    expect(invoked.map((args) => args.slice(0, 2))).toEqual([
      ["item", "list"],
      ["item", "create"],
      ["item", "list"],
      ["read", "-n"],
    ]);
  });

  test("typed failures redact output and high-level buffers are wiped", async () => {
    const stdout = Buffer.from(PHRASE);
    const stderr = Buffer.from(`provider leaked ${PHRASE}`);
    let stdinReference: Uint8Array | undefined;
    const run: RunOnePassword = async (_exe, _args, stdin) => {
      stdinReference = stdin;
      return { outcome: "exit", code: 1, stdout, stderr, childStarted: true };
    };
    const outcome = await createOnePasswordRecoveryItem({ ...provider(), run }, {
      accountUuid: OP_ACCOUNT,
      vaultUuid: VAULT,
      operationTag: TAG,
      rboxAccountId: ACCOUNT,
      phrase: PHRASE,
    });
    expect(outcome).toEqual({ state: "ambiguous", reason: "provider-rejected" });
    expect(JSON.stringify(outcome)).not.toContain(PHRASE);
    expect(stdout.every((byte) => byte === 0)).toBe(true);
    expect(stderr.every((byte) => byte === 0)).toBe(true);
    expect(stdinReference?.every((byte) => byte === 0)).toBe(true);
  });

  test("process runner bounds time/output and classifies pre-child failures", async () => {
    await scenario({ sleep: 5_000 });
    const timeout = await runOnePasswordProcess(fakeOp, ["--version"], undefined, { HOME: tmp, PATH: process.env.PATH }, {
      timeoutMs: 20,
      stdoutBytes: 128,
      stderrBytes: 128,
      killGraceMs: 20,
    });
    expect(timeout.outcome).toBe("timeout");
    timeout.stdout.fill(0);
    timeout.stderr.fill(0);

    const missing = await runOnePasswordProcess(path.join(tmp, "missing-op"), [], undefined, {}, {
      timeoutMs: 100,
      stdoutBytes: 10,
      stderrBytes: 10,
    });
    expect(missing).toMatchObject({ outcome: "spawn-error", reason: "enoent", childStarted: false });

    await scenario({ version: { stdout: "x".repeat(10_000) } });
    const overflow = await runOnePasswordProcess(fakeOp, ["--version"], undefined, { HOME: tmp, PATH: process.env.PATH }, {
      timeoutMs: 5_000,
      stdoutBytes: 32,
      stderrBytes: 32,
      killGraceMs: 20,
    });
    expect(overflow.outcome).toBe("overflow");
    overflow.stdout.fill(0);
    overflow.stderr.fill(0);
  });

  test("process runner cancellation terminates a started fake op", async () => {
    await scenario({ sleep: 5_000 });
    const controller = new AbortController();
    const pending = runOnePasswordProcess(fakeOp, ["--version"], undefined, { HOME: tmp, PATH: process.env.PATH }, {
      timeoutMs: 5_000,
      stdoutBytes: 128,
      stderrBytes: 128,
      killGraceMs: 20,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    const result = await pending;
    expect(result.outcome).toBe("cancelled");
    result.stdout.fill(0);
    result.stderr.fill(0);

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    const notStarted = await runOnePasswordProcess(fakeOp, ["--version"], undefined, { HOME: tmp }, {
      timeoutMs: 5_000,
      stdoutBytes: 128,
      stderrBytes: 128,
      signal: alreadyCancelled.signal,
    });
    expect(notStarted).toMatchObject({ outcome: "cancelled", childStarted: false });
  });
});
