import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearCredentials,
  credentialsForStrictFlow,
  installCredentialTestHeartbeatInterval,
  installCredentialTestHook,
  loadCredentials,
  parseCredentialDocument,
  saveCredentials,
} from "./credentials.js";

let home: string;
let priorEnv: NodeJS.ProcessEnv;
let restoreHook: (() => void) | undefined;
let restoreHeartbeat: (() => void) | undefined;
const fixedNow = new Date("2026-07-17T12:34:56.789Z");
const credential = { token: "tok_secret", deviceId: "dev_1", remoteUrl: "https://api.test", accountId: "acct_0000000000000001" };
const credentialPath = () => path.join(home, ".rbox", "credentials.json");
const lockPath = () => path.join(home, ".rbox", "credentials.lock");

async function waitUntil(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await condition())) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function beforeDeadline<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function writeCorruptCredential(raw = "{lock-mutation-evidence"): Promise<void> {
  await fs.mkdir(path.dirname(credentialPath()), { recursive: true, mode: 0o700 });
  await fs.writeFile(credentialPath(), raw, { mode: 0o600 });
}

beforeEach(async () => {
  priorEnv = { ...process.env };
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-credentials-"));
  process.env.HOME = home;
  delete process.env.RBOX_TOKEN;
  delete process.env.RBOX_DEVICE_ID;
  delete process.env.RBOX_API;
  delete process.env.RBOX_ACCOUNT_ID;
  setSystemTime(fixedNow);
});

afterEach(async () => {
  restoreHook?.();
  restoreHook = undefined;
  restoreHeartbeat?.();
  restoreHeartbeat = undefined;
  setSystemTime();
  process.env = priorEnv;
  await fs.rm(home, { recursive: true, force: true });
});

test("RBOX_HOME isolates the credential store while HOME stays untouched (#505)", async () => {
  await saveCredentials({ ...credential, token: "tok_production" });
  expect(await fs.readFile(credentialPath(), "utf8")).toContain("tok_production");

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-credentials-scratch-"));
  process.env.RBOX_HOME = scratch;
  try {
    // HOME still points at the "production" home holding a valid credential.
    expect(process.env.HOME).toBe(home);
    expect((await loadCredentials()).state).toBe("absent");

    await saveCredentials({ ...credential, token: "tok_scratch" });
    const scratchFile = path.join(scratch, ".rbox", "credentials.json");
    expect(await fs.readFile(scratchFile, "utf8")).toContain("tok_scratch");

    const loaded = await loadCredentials();
    expect(loaded.state).toBe("valid");
    if (loaded.state === "valid") expect(loaded.credentials.token).toBe("tok_scratch");
  } finally {
    delete process.env.RBOX_HOME;
    await fs.rm(scratch, { recursive: true, force: true });
  }

  // The production credential under HOME is untouched and readable again.
  const back = await loadCredentials();
  expect(back.state).toBe("valid");
  if (back.state === "valid") expect(back.credentials.token).toBe("tok_production");
});

test("parser accepts v1 and both legacy shapes while preserving only unknown extensions", () => {
  for (const [legacy, value] of [
    [false, { v: 1, ...credential, extra: { retained: true } }],
    [true, { token: credential.token, deviceId: credential.deviceId, remoteUrl: credential.remoteUrl, extra: 7 }],
    [true, { ...credential, extra: [1, 2] }],
  ] as const) {
    const parsed = parseCredentialDocument(JSON.stringify(value));
    expect(parsed.state).toBe("valid");
    if (parsed.state === "valid") {
      expect(parsed.legacy).toBe(legacy);
      expect(parsed.credentials.v).toBe(1);
      expect(parsed.extensions).toEqual({ extra: value.extra });
    }
  }
});

test("parser distinguishes malformed versions, future integer versions, and malformed fields", () => {
  for (const v of ["1", null, {}, [], 1.5]) {
    expect(parseCredentialDocument(JSON.stringify({ v, ...credential })).state).toBe("corrupt");
  }
  for (const v of [0, -1, 2, 99]) {
    const parsed = parseCredentialDocument(JSON.stringify({ v, ...credential }));
    expect(parsed).toEqual({ state: "unsupported-version", version: v });
  }
  for (const value of [
    null,
    [],
    { v: 1, ...credential, token: "" },
    { v: 1, ...credential, deviceId: 2 },
    { v: 1, ...credential, remoteUrl: "file:///tmp/x" },
    { v: 1, ...credential, accountId: "" },
    { v: 1, ...credential, accountId: "acct_a" },
    { v: 1, ...credential, accountId: "acct_A123456789abcdef" },
    { v: 1, ...credential, accountId: "acct_../../escape" },
  ]) expect(parseCredentialDocument(JSON.stringify(value)).state).toBe("corrupt");
});

test("strict policy distinguishes first-run absence from every degraded typed state", () => {
  expect(credentialsForStrictFlow({ state: "absent", path: "/test/credentials.json" })).toBeUndefined();
  for (const degraded of [
    { state: "corrupt" as const, path: "/test/credentials.json", detail: "bad schema" },
    { state: "unreadable" as const, path: "/test/credentials.json", detail: "EACCES" },
    { state: "unsupported-version" as const, path: "/test/credentials.json", version: 2 },
    { state: "invalid-environment" as const, variable: "RBOX_API" as const, detail: "invalid URL" },
  ]) expect(() => credentialsForStrictFlow(degraded)).toThrow(degraded.state);
});

test("an absent read does not materialize ~/.rbox and absent/valid reads never acquire the lock", async () => {
  let lockAttempted = false;
  restoreHook = installCredentialTestHook((seam) => {
    if (seam === "lock-before-acquire") lockAttempted = true;
  });

  expect(await loadCredentials()).toEqual({ state: "absent", path: credentialPath() });
  expect(lockAttempted).toBe(false);
  await expect(fs.lstat(path.join(home, ".rbox"))).rejects.toThrow();

  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  await fs.writeFile(credentialPath(), JSON.stringify({ v: 1, ...credential }), { mode: 0o600 });
  const valid = await loadCredentials();
  expect(valid.state).toBe("valid");
  expect(lockAttempted).toBe(false);
  await expect(fs.lstat(lockPath())).rejects.toThrow();
  await expect(fs.lstat(`${lockPath()}.fence`)).rejects.toThrow();
});

test("an unreadable disk classification returns without acquiring the lock", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  await fs.mkdir(credentialPath());
  let lockAttempted = false;
  restoreHook = installCredentialTestHook((seam) => {
    if (seam === "lock-before-acquire") lockAttempted = true;
  });

  expect((await loadCredentials()).state).toBe("unreadable");
  expect(lockAttempted).toBe(false);
  await expect(fs.lstat(lockPath())).rejects.toThrow();
});

test("an optimistic valid read retries an atomic save that lands between lstat and open", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  await fs.writeFile(credentialPath(), JSON.stringify({ v: 1, ...credential, token: "old" }), { mode: 0o600 });
  let saveLanded = false;
  restoreHook = installCredentialTestHook(async (seam) => {
    if (seam !== "source-after-lstat" || saveLanded) return;
    saveLanded = true;
    await saveCredentials({ ...credential, token: "new" });
  });

  const loaded = await loadCredentials();
  expect(saveLanded).toBe(true);
  expect(loaded.state).toBe("valid");
  if (loaded.state === "valid") expect(loaded.credentials.token).toBe("new");
  expect((await fs.readdir(path.dirname(credentialPath()))).some((name) => name.includes(".corrupt-"))).toBe(false);
});

test("absent, v1 save, exact mode, whitelist, and typed strict adapter", async () => {
  expect(await loadCredentials()).toEqual({ state: "absent", path: credentialPath() });
  await saveCredentials({ ...credential, v: 1, ignored: "drop" } as never);
  const raw = await fs.readFile(credentialPath(), "utf8");
  expect(JSON.parse(raw)).toEqual({ v: 1, ...credential });
  expect((await fs.stat(credentialPath())).mode & 0o777).toBe(0o600);
  expect(await fs.lstat(lockPath()).then(() => false).catch(() => true)).toBe(true);
  const loaded = await loadCredentials();
  expect(loaded.state).toBe("valid");
  expect(credentialsForStrictFlow(loaded)).toEqual({ v: 1, ...credential });
});

test("legacy load never rewrites, then the next save migrates and drops extensions", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  const legacy = JSON.stringify({ ...credential, futureHint: { x: 1 } });
  await fs.writeFile(credentialPath(), legacy, { mode: 0o600 });
  const before = await fs.stat(credentialPath());
  const loaded = await loadCredentials();
  expect(loaded.state).toBe("valid");
  if (loaded.state === "valid") {
    expect(loaded.legacy).toBe(true);
    expect(loaded.extensions).toEqual({ futureHint: { x: 1 } });
    await saveCredentials(loaded.credentials);
  }
  expect((await fs.stat(credentialPath())).mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs);
  expect(JSON.parse(await fs.readFile(credentialPath(), "utf8"))).toEqual({ v: 1, ...credential });
});

test("load quarantine preserves exact corrupt bytes at 0600 and uses collision counters", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  const raw = Buffer.from("{\"token\":\"secret\",\n", "utf8");
  await fs.writeFile(credentialPath(), raw, { mode: 0o640 });
  const base = `${credentialPath()}.corrupt-2026-07-17T12-34-56-789Z`;
  await fs.writeFile(base, "existing", { mode: 0o600 });
  await fs.writeFile(`${base}-1`, "existing-1", { mode: 0o600 });
  let sourceReads = 0;
  let lockAttempted = false;
  restoreHook = installCredentialTestHook((seam) => {
    if (seam === "source-after-read") sourceReads++;
    if (seam === "lock-before-acquire") lockAttempted = true;
  });
  const loaded = await loadCredentials();
  expect(loaded.state).toBe("corrupt");
  if (loaded.state === "corrupt") expect(loaded.quarantinedTo).toBe(`${base}-2`);
  expect(await fs.readFile(`${base}-2`)).toEqual(raw);
  expect((await fs.stat(`${base}-2`)).mode & 0o777).toBe(0o600);
  expect(await fs.readFile(base, "utf8")).toBe("existing");
  expect(await fs.readFile(`${base}-1`, "utf8")).toBe("existing-1");
  expect(sourceReads).toBe(2);
  expect(lockAttempted).toBe(true);
  await expect(fs.lstat(credentialPath())).rejects.toThrow();
});

test("load rechecks under the mutation lock and preserves a concurrent valid save", async () => {
  const raw = Buffer.from("{corrupt-before-concurrent-save");
  await writeCorruptCredential(raw.toString("utf8"));
  let saveLanded = false;
  restoreHook = installCredentialTestHook(async (seam) => {
    if (seam !== "load-before-mutation-lock" || saveLanded) return;
    saveLanded = true;
    await saveCredentials({ ...credential, token: "concurrent-valid" });
  });

  const loaded = await loadCredentials();
  expect(saveLanded).toBe(true);
  expect(loaded.state).toBe("valid");
  if (loaded.state === "valid") expect(loaded.credentials.token).toBe("concurrent-valid");
  expect(JSON.parse(await fs.readFile(credentialPath(), "utf8")).token).toBe("concurrent-valid");
  const quarantines = (await fs.readdir(path.dirname(credentialPath()))).filter((name) => name.includes(".corrupt-"));
  expect(quarantines).toHaveLength(1);
  expect(await fs.readFile(path.join(path.dirname(credentialPath()), quarantines[0]!))).toEqual(raw);
});

test("future version is typed and quarantined; save preflight preserves malformed evidence", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  const future = Buffer.from(JSON.stringify({ v: 2, ...credential }));
  await fs.writeFile(credentialPath(), future, { mode: 0o600 });
  const futureResult = await loadCredentials();
  expect(futureResult.state).toBe("unsupported-version");
  if (futureResult.state === "unsupported-version") expect(await fs.readFile(futureResult.quarantinedTo!)).toEqual(future);

  const malformed = Buffer.from("{bad-login-preflight");
  await fs.writeFile(credentialPath(), malformed, { mode: 0o600 });
  await saveCredentials(credential);
  expect(JSON.parse(await fs.readFile(credentialPath(), "utf8"))).toEqual({ v: 1, ...credential });
  const names = await fs.readdir(path.dirname(credentialPath()));
  const copies = names.filter((name) => name.startsWith("credentials.json.corrupt-"));
  expect(copies.length).toBe(2);
  expect(await Promise.all(copies.map((name) => fs.readFile(path.join(path.dirname(credentialPath()), name))))).toContainEqual(malformed);
});

test("readable bad-schema disk input returns corrupt and is quarantined", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  const badSchema = Buffer.from(JSON.stringify({ v: 1, token: "tok", deviceId: "dev", remoteUrl: "relative" }));
  await fs.writeFile(credentialPath(), badSchema, { mode: 0o600 });
  const result = await loadCredentials();
  expect(result.state).toBe("corrupt");
  if (result.state === "corrupt") expect(await fs.readFile(result.quarantinedTo!)).toEqual(badSchema);
});

test("valid env override and every invalid auxiliary env value leave corrupt disk untouched", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  const raw = Buffer.from("{broken-disk");
  await fs.writeFile(credentialPath(), raw, { mode: 0o600 });
  let lockAttempted = false;
  restoreHook = installCredentialTestHook((seam) => {
    if (seam === "lock-before-acquire") lockAttempted = true;
  });
  process.env.RBOX_TOKEN = "env-token";
  process.env.RBOX_DEVICE_ID = "env-device";
  process.env.RBOX_API = "https://env.test";
  process.env.RBOX_ACCOUNT_ID = "acct_eeeeeeeeeeeeeeee";
  const valid = await loadCredentials();
  expect(valid.state).toBe("valid");
  if (valid.state === "valid") expect(valid.source).toBe("env");
  expect(await fs.readFile(credentialPath())).toEqual(raw);

  for (const [variable, value] of [["RBOX_DEVICE_ID", ""], ["RBOX_API", "relative"], ["RBOX_ACCOUNT_ID", ""], ["RBOX_ACCOUNT_ID", "acct_a"]] as const) {
    process.env.RBOX_DEVICE_ID = "env-device";
    process.env.RBOX_API = "https://env.test";
    process.env.RBOX_ACCOUNT_ID = "acct_eeeeeeeeeeeeeeee";
    process.env[variable] = value;
    const result = await loadCredentials();
    expect(result.state).toBe("invalid-environment");
    if (result.state === "invalid-environment") expect(result.variable).toBe(variable);
    expect(await fs.readFile(credentialPath())).toEqual(raw);
  }
  expect((await fs.readdir(path.dirname(credentialPath()))).filter((name) => name.includes(".corrupt-")).length).toBe(0);
  expect(lockAttempted).toBe(false);
});

test("symlink and non-regular credential destinations are unreadable and save refuses", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  const target = path.join(home, "target.json");
  await fs.writeFile(target, JSON.stringify({ v: 1, ...credential }));
  await fs.symlink(target, credentialPath());
  expect((await loadCredentials()).state).toBe("unreadable");
  await expect(saveCredentials(credential)).rejects.toThrow();
  expect(await fs.readFile(target, "utf8")).toContain("tok_secret");
  await fs.unlink(credentialPath());
  await fs.mkdir(credentialPath());
  expect((await loadCredentials()).state).toBe("unreadable");
  await expect(saveCredentials(credential)).rejects.toThrow();
});

test("secure directory creation is 0700 and unsafe mode or symlinked parent is refused", async () => {
  await saveCredentials(credential);
  expect((await fs.stat(path.dirname(credentialPath()))).mode & 0o777).toBe(0o700);
  await fs.chmod(path.dirname(credentialPath()), 0o720);
  await expect(saveCredentials(credential)).rejects.toThrow(/group\/world writable/);
  expect((await loadCredentials()).state).toBe("unreadable");

  await fs.rm(path.join(home, ".rbox"), { recursive: true, force: true });
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-credentials-link-"));
  try {
    await fs.symlink(elsewhere, path.join(home, ".rbox"));
    expect((await loadCredentials()).state).toBe("unreadable");
    await expect(saveCredentials(credential)).rejects.toThrow(/unsafe credential directory/);
  } finally {
    await fs.rm(path.join(home, ".rbox"), { force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  }
});

test("world-writable secret parent is refused independently of system ancestor modes", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  await fs.chmod(path.dirname(credentialPath()), 0o702);
  await expect(saveCredentials(credential)).rejects.toThrow(/group\/world writable/);
  expect((await loadCredentials()).state).toBe("unreadable");
});

test.skipIf(typeof process.geteuid !== "function" || process.geteuid() === 0)("chmod-000 credential is typed unreadable and is never quarantined", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  await fs.writeFile(credentialPath(), JSON.stringify({ v: 1, ...credential }), { mode: 0o600 });
  await fs.chmod(credentialPath(), 0o000);
  try {
    expect((await loadCredentials()).state).toBe("unreadable");
    expect((await fs.readdir(path.dirname(credentialPath()))).some((name) => name.includes(".corrupt-"))).toBe(false);
  } finally {
    await fs.chmod(credentialPath(), 0o600);
  }
});

test("oversized, malformed, and future lock markers fail closed without being reaped", async () => {
  await fs.mkdir(path.dirname(lockPath()), { mode: 0o700 });
  await writeCorruptCredential();
  for (const raw of [
    "x".repeat(2048),
    JSON.stringify({ v: 1, pid: process.pid, processStart: "garbage", acquiredAt: fixedNow.toISOString(), nonce: "a".repeat(32) }),
    JSON.stringify({ v: 1, pid: process.pid, processStart: "1", acquiredAt: new Date(fixedNow.getTime() + 60_000).toISOString(), nonce: "b".repeat(32) }),
  ]) {
    await fs.writeFile(lockPath(), raw, { mode: 0o600 });
    const result = await loadCredentials();
    expect(result.state).toBe("unreadable");
    expect(await fs.readFile(lockPath(), "utf8")).toBe(raw);
  }
});

test("abandoned fence is recovered only when its exact process incarnation is dead", async () => {
  const fence = `${lockPath()}.fence`;
  await fs.mkdir(path.dirname(fence), { mode: 0o700 });
  await writeCorruptCredential();
  await fs.writeFile(fence, JSON.stringify({ v: 1, pid: 999_999, processStart: "1", acquiredAt: fixedNow.toISOString(), nonce: "c".repeat(32) }), { mode: 0o600 });
  await fs.utimes(fence, fixedNow, fixedNow);
  expect((await loadCredentials()).state).toBe("corrupt");
  await expect(fs.lstat(fence)).rejects.toThrow();

  await writeCorruptCredential();
  const future = JSON.stringify({ v: 1, pid: 999_999, processStart: "1", acquiredAt: new Date(fixedNow.getTime() + 60_000).toISOString(), nonce: "d".repeat(32) });
  await fs.writeFile(fence, future, { mode: 0o600 });
  await fs.utimes(fence, fixedNow, fixedNow);
  expect((await loadCredentials()).state).toBe("unreadable");
  expect(await fs.readFile(fence, "utf8")).toBe(future);
});

test("separate save processes serialize and leave one complete v1 document", async () => {
  setSystemTime();
  const modulePath = path.join(process.cwd(), "src", "cli", "credentials.ts");
  const spawnSave = (token: string) => Bun.spawn({
    cmd: [process.execPath, "-e", `import { saveCredentials } from ${JSON.stringify(modulePath)}; await saveCredentials({token:${JSON.stringify(token)},deviceId:"dev",remoteUrl:"https://api.test",accountId:"acct_cccccccccccccccc"});`],
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const first = spawnSave("one");
  const second = spawnSave("two");
  expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
  const saved = JSON.parse(await fs.readFile(credentialPath(), "utf8"));
  expect(saved.v).toBe(1);
  expect(["one", "two"]).toContain(saved.token);
  await expect(fs.lstat(lockPath())).rejects.toThrow();
});

test("a fence released inside the inspection window is a retry, not a lost writer", async () => {
  setSystemTime();
  const fence = `${lockPath()}.fence`;
  await fs.mkdir(path.dirname(fence), { mode: 0o700 });
  const identity = await (await import("../engine/git/lockfile.js")).systemLockIdentity.current();
  // A live peer holds the fence, so this writer's publication collides and it
  // must inspect the holder's marker.
  await fs.writeFile(fence, JSON.stringify({
    v: 1, pid: process.pid, processStart: identity.startTime, acquiredAt: new Date().toISOString(), nonce: "e".repeat(32),
  }), { mode: 0o600 });
  let released = false;
  restoreHook = installCredentialTestHook(async (seam, context) => {
    // The peer finishes and releases in the one unfenced window that exists:
    // between this writer's lstat of the fence and its open of the same path.
    if (seam !== "marker-observe-before-open" || context.markerPath !== fence || released) return;
    released = true;
    await fs.unlink(fence);
  });
  await saveCredentials(credential);
  expect(released).toBe(true);
  expect(JSON.parse(await fs.readFile(credentialPath(), "utf8"))).toEqual({ v: 1, ...credential });
  await expect(fs.lstat(fence)).rejects.toThrow();
});

test("a peer that cycles the fence exhausts the budget and names the churn", async () => {
  setSystemTime();
  const fence = `${lockPath()}.fence`;
  await fs.mkdir(path.dirname(fence), { mode: 0o700 });
  const identity = await (await import("../engine/git/lockfile.js")).systemLockIdentity.current();
  // Allocate the successor while the current marker is still linked, then
  // rename it over: the two inodes coexist, so the replacement can never
  // inherit the old inode number. Unlink-then-create would let the allocator
  // hand back the same inode — every marker here is the same size and mode, so
  // the inode is the ONLY thing that makes the swap observable.
  const republish = (nonce: string) => {
    const swap = `${fence}.swap`;
    fsSync.writeFileSync(swap, JSON.stringify({
      v: 1, pid: process.pid, processStart: identity.startTime, acquiredAt: new Date().toISOString(), nonce: nonce.repeat(32),
    }), { mode: 0o600 });
    fsSync.renameSync(swap, fence);
  };
  republish("a");
  let cycles = 0;
  restoreHook = installCredentialTestHook((seam, context) => {
    // A peer that keeps taking and releasing the fence. The swap is synchronous
    // inside the inspection window the seam names, so every attempt observes a
    // turnover no matter how the runner schedules this process.
    if (seam !== "marker-observe-before-open" || context.markerPath !== fence) return;
    cycles++;
    republish(String(cycles % 10));
  });
  const failure = await saveCredentials(credential).then(() => undefined, (error: unknown) => error as Error);
  // Boundedness comes from the hook's own attempt count, not from elapsed time:
  // the budget exhausted after a finite number of inspections, and the message
  // reports every one of them as churn rather than a stuck holder.
  expect(cycles).toBeGreaterThan(1);
  expect(failure?.message).toContain(`${cycles} of ${cycles} attempts saw the marker change during inspection`);
});

test("five-minute stale main marker is taken over independent of its live PID", async () => {
  await fs.mkdir(path.dirname(lockPath()), { mode: 0o700 });
  const stale = { v: 1, pid: process.pid, processStart: "1", acquiredAt: fixedNow.toISOString(), nonce: "a".repeat(32) };
  await fs.writeFile(lockPath(), JSON.stringify(stale), { mode: 0o600 });
  const old = new Date(fixedNow.getTime() - 5 * 60_000);
  await fs.utimes(lockPath(), old, old);
  await saveCredentials(credential);
  expect(JSON.parse(await fs.readFile(credentialPath(), "utf8"))).toEqual({ v: 1, ...credential });
  await expect(fs.lstat(lockPath())).rejects.toThrow();
});

test("a long fenced operation refreshes the main marker while retaining its fence", async () => {
  setSystemTime();
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  await fs.writeFile(credentialPath(), "{heartbeat-evidence", { mode: 0o600 });
  restoreHeartbeat = installCredentialTestHeartbeatInterval(10);
  let enteredResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  let releaseResolve!: () => void;
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  restoreHook = installCredentialTestHook(async (seam) => {
    if (seam !== "quarantine-copy-durable") return;
    enteredResolve();
    await release;
  });
  const loading = loadCredentials();
  await entered;
  const before = (await fs.stat(lockPath())).mtimeMs;
  let loaded: Awaited<ReturnType<typeof loadCredentials>>;
  try {
    await waitUntil(async () => (await fs.stat(lockPath())).mtimeMs > before, "credential lock heartbeat");
    expect(await fs.lstat(`${lockPath()}.fence`).then((stat) => stat.isFile())).toBe(true);
  } finally {
    releaseResolve();
    loaded = await loading;
  }
  expect(loaded.state).toBe("corrupt");
});

test("fresh main contention and a live exact-incarnation fence fail closed without reaping", async () => {
  setSystemTime();
  const identityModule = await import("../engine/git/lockfile.js");
  const identity = await identityModule.systemLockIdentity.current();
  for (const target of [lockPath(), `${lockPath()}.fence`]) {
    await fs.rm(path.join(home, ".rbox"), { recursive: true, force: true });
    await fs.mkdir(path.dirname(target), { mode: 0o700 });
    await writeCorruptCredential();
    const raw = JSON.stringify({ v: 1, pid: process.pid, processStart: identity.startTime, acquiredAt: new Date().toISOString(), nonce: "9".repeat(32) });
    await fs.writeFile(target, raw, { mode: 0o600 });
    expect((await loadCredentials()).state).toBe("unreadable");
    expect(await fs.readFile(target, "utf8")).toBe(raw);
  }
});

test("separately spawned load and save serialize one corrupt evidence quarantine", async () => {
  setSystemTime();
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  const evidence = Buffer.from("{spawned-load-save-evidence");
  await fs.writeFile(credentialPath(), evidence, { mode: 0o600 });
  const modulePath = path.join(process.cwd(), "src", "cli", "credentials.ts");
  const spawn = (body: string) => Bun.spawn({
    cmd: [process.execPath, "-e", `import * as c from ${JSON.stringify(modulePath)}; ${body}`],
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const loader = spawn("await c.loadCredentials();");
  const saver = spawn('await c.saveCredentials({token:"saved",deviceId:"dev",remoteUrl:"https://api.test",accountId:"acct_cccccccccccccccc"});');
  expect(await Promise.all([loader.exited, saver.exited])).toEqual([0, 0]);
  expect(JSON.parse(await fs.readFile(credentialPath(), "utf8")).token).toBe("saved");
  const quarantines = (await fs.readdir(path.dirname(credentialPath()))).filter((name) => name.includes(".corrupt-"));
  expect(quarantines).toHaveLength(1);
  expect(await fs.readFile(path.join(path.dirname(credentialPath()), quarantines[0]!))).toEqual(evidence);
});

test("logout-only destructive recovery clears a malformed marker and prints the idempotent remedy", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  await fs.writeFile(credentialPath(), JSON.stringify({ v: 1, ...credential }), { mode: 0o600 });
  await fs.writeFile(lockPath(), "tampered", { mode: 0o600 });
  const warnings: string[] = [];
  const oldWarn = console.warn;
  console.warn = (line?: unknown) => void warnings.push(String(line ?? ""));
  try {
    await clearCredentials();
  } finally {
    console.warn = oldWarn;
  }
  expect(warnings.join("\n")).toContain("destructive-recovery override");
  expect(warnings.join("\n")).toContain("if another rbox process was signing in concurrently, run `rbox logout` again");
  await expect(fs.lstat(credentialPath())).rejects.toThrow();
  await expect(fs.lstat(lockPath())).rejects.toThrow();
});

test("logout recovery refuses an unprovable symlink target and removes nothing", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  const target = path.join(home, "outside-secret");
  await fs.writeFile(target, "keep");
  await fs.symlink(target, credentialPath());
  await expect(clearCredentials()).rejects.toThrow(/could not be cleared safely/);
  expect(await fs.readFile(target, "utf8")).toBe("keep");
  expect((await fs.lstat(credentialPath())).isSymbolicLink()).toBe(true);
});

test.skipIf(process.platform !== "darwin")("native macOS atomic save and exact-byte quarantine", async () => {
  await saveCredentials(credential);
  expect((await fs.stat(credentialPath())).mode & 0o777).toBe(0o600);
  const raw = Buffer.from("{native-macos-corrupt");
  await fs.writeFile(credentialPath(), raw, { mode: 0o600 });
  const result = await loadCredentials();
  expect(result.state).toBe("corrupt");
  if (result.state === "corrupt") expect(await fs.readFile(result.quarantinedTo!)).toEqual(raw);
});

test("a durable quarantine copy survives a crash before source removal", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  const raw = Buffer.from("{crash-between-copy-and-removal");
  await fs.writeFile(credentialPath(), raw, { mode: 0o600 });
  restoreHook = installCredentialTestHook((seam) => {
    if (seam === "quarantine-copy-durable") throw new Error("simulated crash");
  });
  expect((await loadCredentials()).state).toBe("unreadable");
  expect(await fs.readFile(credentialPath())).toEqual(raw);
  const preserved = (await fs.readdir(path.dirname(credentialPath()))).find((name) => name.includes(".corrupt-"));
  expect(preserved).toBeDefined();
  expect(await fs.readFile(path.join(path.dirname(credentialPath()), preserved!))).toEqual(raw);
});

test("source identity swaps at every open/read boundary preserve the replacement", async () => {
  for (const seam of ["source-after-lstat", "source-after-open", "source-after-fstat", "source-after-read"] as const) {
    await fs.rm(path.join(home, ".rbox"), { recursive: true, force: true });
    await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
    await fs.writeFile(credentialPath(), "{original-corrupt", { mode: 0o600 });
    const displaced = `${credentialPath()}.displaced`;
    let swapped = false;
    let observations = 0;
    restoreHook = installCredentialTestHook(async (observed) => {
      if (observed !== seam || swapped || ++observations !== 2) return;
      swapped = true;
      await fs.rename(credentialPath(), displaced);
      await fs.writeFile(credentialPath(), "replacement-must-survive", { mode: 0o600 });
    });
    expect((await loadCredentials()).state).toBe("unreadable");
    expect(await fs.readFile(credentialPath(), "utf8")).toBe("replacement-must-survive");
    restoreHook();
    restoreHook = undefined;
  }
});

test("pre-removal identity swap retains both the quarantine copy and replacement", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  const original = Buffer.from("{original-before-removal");
  await fs.writeFile(credentialPath(), original, { mode: 0o600 });
  restoreHook = installCredentialTestHook(async (seam) => {
    if (seam !== "quarantine-before-source-remove") return;
    await fs.rename(credentialPath(), `${credentialPath()}.old`);
    await fs.writeFile(credentialPath(), "replacement-must-survive", { mode: 0o600 });
  });
  expect((await loadCredentials()).state).toBe("unreadable");
  expect(await fs.readFile(credentialPath(), "utf8")).toBe("replacement-must-survive");
  const preserved = (await fs.readdir(path.dirname(credentialPath()))).find((name) => name.includes(".corrupt-"));
  expect(await fs.readFile(path.join(path.dirname(credentialPath()), preserved!))).toEqual(original);
});

test("atomic save faults before rename leave the prior credential intact", async () => {
  await saveCredentials({ ...credential, token: "prior" });
  for (const seam of ["atomic-temp-opened", "atomic-temp-written", "atomic-temp-synced", "atomic-temp-closed", "atomic-before-rename"] as const) {
    restoreHook = installCredentialTestHook((observed) => {
      if (observed === seam) throw new Error(`injected ${seam}`);
    });
    await expect(saveCredentials({ ...credential, token: "next" })).rejects.toThrow(`injected ${seam}`);
    expect(JSON.parse(await fs.readFile(credentialPath(), "utf8")).token).toBe("prior");
    restoreHook();
    restoreHook = undefined;
  }
});

test("directory sync failure is best-effort after a successful atomic save", async () => {
  const warnings: string[] = [];
  const oldWarn = console.warn;
  console.warn = (value?: unknown) => void warnings.push(String(value));
  restoreHook = installCredentialTestHook((seam) => {
    if (seam === "save-before-directory-sync") throw new Error("injected directory sync failure");
  });
  try {
    await saveCredentials(credential);
  } finally {
    console.warn = oldWarn;
  }
  expect(JSON.parse(await fs.readFile(credentialPath(), "utf8"))).toEqual({ v: 1, ...credential });
  expect(warnings.join("\n")).toContain("credential directory sync failed");
});

test("an actual rename failure leaves the prior atomic credential intact", async () => {
  await saveCredentials({ ...credential, token: "prior" });
  restoreHook = installCredentialTestHook(async (seam) => {
    if (seam !== "atomic-before-rename") return;
    const temp = (await fs.readdir(path.dirname(credentialPath()))).find((name) => name.startsWith(".rbox-tmp-"));
    expect(temp).toBeDefined();
    await fs.unlink(path.join(path.dirname(credentialPath()), temp!));
  });
  await expect(saveCredentials({ ...credential, token: "next" })).rejects.toThrow();
  expect(JSON.parse(await fs.readFile(credentialPath(), "utf8")).token).toBe("prior");
});

test("fence and main-lock publication faults expose no partial final marker", async () => {
  const seams = [
    "marker-temp-opened", "marker-temp-written", "marker-temp-synced", "marker-temp-closed",
    "marker-before-link", "marker-after-link", "marker-before-temp-cleanup", "marker-after-temp-cleanup",
  ] as const;
  for (const faultedPath of [`${lockPath()}.fence`, lockPath()]) {
    for (const seam of seams) {
      await fs.rm(path.join(home, ".rbox"), { recursive: true, force: true });
      await writeCorruptCredential();
      restoreHook = installCredentialTestHook((observed, context) => {
        if (observed === seam && context.markerPath === faultedPath) throw new Error(`injected ${seam}`);
      });
      expect((await loadCredentials()).state).toBe("unreadable");
      for (const finalPath of [lockPath(), `${lockPath()}.fence`]) {
        try {
          const raw = await fs.readFile(finalPath, "utf8");
          const marker = JSON.parse(raw);
          expect(Object.keys(marker).sort()).toEqual(["acquiredAt", "nonce", "pid", "processStart", "v"]);
          expect(marker.v).toBe(1);
          expect(marker.nonce).toMatch(/^[0-9a-f]{32}$/);
        } catch (error) {
          expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
        }
      }
      restoreHook();
      restoreHook = undefined;
    }
  }
});

test("a successor swapped into the main marker path is never removed", async () => {
  await writeCorruptCredential();
  let successor = "";
  restoreHook = installCredentialTestHook(async (seam, context) => {
    if (seam !== "marker-after-link" || context.markerPath !== lockPath() || successor) return;
    const current = JSON.parse(await fs.readFile(lockPath(), "utf8"));
    successor = JSON.stringify({ ...current, nonce: "f".repeat(32) });
    await fs.unlink(lockPath());
    await fs.writeFile(lockPath(), successor, { mode: 0o600 });
  });
  expect((await loadCredentials()).state).toBe("unreadable");
  expect(await fs.readFile(lockPath(), "utf8")).toBe(successor);
});

test("marker hardlink EEXIST is handled for both fence and main publication", async () => {
  for (const collidedPath of [`${lockPath()}.fence`, lockPath()]) {
    await fs.rm(path.join(home, ".rbox"), { recursive: true, force: true });
    await writeCorruptCredential();
    let collided = false;
    restoreHook = installCredentialTestHook(async (seam, context) => {
      if (seam !== "marker-before-link" || context.markerPath !== collidedPath || collided) return;
      collided = true;
      await fs.writeFile(context.markerPath, await fs.readFile(context.tempPath), { mode: 0o600 });
    });
    expect((await loadCredentials()).state).toBe("unreadable");
    expect(collided).toBe(true);
    const marker = JSON.parse(await fs.readFile(collidedPath, "utf8"));
    expect(marker.v).toBe(1);
    expect(marker.nonce).toMatch(/^[0-9a-f]{32}$/);
    restoreHook();
    restoreHook = undefined;
  }
});

test("unsupported marker hardlinks fail closed with no partial final marker", async () => {
  await writeCorruptCredential();
  const originalLink = fs.link;
  (fs as unknown as { link: typeof fs.link }).link = async () => {
    const error = new Error("hardlinks unsupported") as NodeJS.ErrnoException;
    error.code = "EOPNOTSUPP";
    throw error;
  };
  try {
    expect((await loadCredentials()).state).toBe("unreadable");
    await expect(fs.lstat(`${lockPath()}.fence`)).rejects.toThrow();
    await expect(fs.lstat(lockPath())).rejects.toThrow();
  } finally {
    (fs as unknown as { link: typeof fs.link }).link = originalLink;
  }
});

test("faulted stale-takeover installation never restores or partially publishes the main marker", async () => {
  await fs.mkdir(path.dirname(lockPath()), { mode: 0o700 });
  await writeCorruptCredential();
  const stale = { v: 1, pid: process.pid, processStart: "1", acquiredAt: fixedNow.toISOString(), nonce: "7".repeat(32) };
  await fs.writeFile(lockPath(), JSON.stringify(stale), { mode: 0o600 });
  const old = new Date(fixedNow.getTime() - 5 * 60_000);
  await fs.utimes(lockPath(), old, old);
  restoreHook = installCredentialTestHook((seam, context) => {
    if (seam === "marker-before-link" && context.markerPath === lockPath()) throw new Error("faulted takeover installation");
  });
  expect((await loadCredentials()).state).toBe("unreadable");
  await expect(fs.lstat(lockPath())).rejects.toThrow();
});

test("secret parent ownership and symlinked HOME ancestors are refused", async () => {
  if (typeof process.geteuid === "function" && process.geteuid() === 0) {
    await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
    await fs.chown(path.dirname(credentialPath()), 65_534, 65_534);
    try {
      await expect(saveCredentials(credential)).rejects.toThrow(/not owned/);
      expect((await loadCredentials()).state).toBe("unreadable");
    } finally {
      await fs.chown(path.dirname(credentialPath()), 0, 0);
    }
  }

  const realHome = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-real-home-"));
  const linkedHome = path.join(home, "linked-home");
  await fs.symlink(realHome, linkedHome);
  process.env.HOME = linkedHome;
  try {
    await expect(saveCredentials(credential)).rejects.toThrow(/unsafe credential directory component/);
    expect((await loadCredentials()).state).toBe("unreadable");
  } finally {
    process.env.HOME = home;
    await fs.rm(realHome, { recursive: true, force: true });
  }
});

test("save refuses a secret-parent seam swap before rename", async () => {
  await saveCredentials({ ...credential, token: "prior" });
  const displaced = path.join(home, ".rbox-displaced");
  restoreHook = installCredentialTestHook(async (seam) => {
    if (seam !== "save-before-parent-recheck") return;
    await fs.rename(path.join(home, ".rbox"), displaced);
    await fs.mkdir(path.join(home, ".rbox"), { mode: 0o700 });
  });
  await expect(saveCredentials({ ...credential, token: "next" })).rejects.toThrow();
  await expect(fs.lstat(credentialPath())).rejects.toThrow();
  expect(JSON.parse(await fs.readFile(path.join(displaced, "credentials.json"), "utf8")).token).toBe("prior");
});

test("logout waits for a normal in-flight credential writer and clears definitively", async () => {
  setSystemTime();
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  await fs.writeFile(credentialPath(), "{writer-evidence", { mode: 0o600 });
  const modulePath = path.join(process.cwd(), "src", "cli", "credentials.ts");
  const writerOwnedPath = path.join(home, ".writer-lock-owned");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      import fs from "node:fs/promises";
      import { installCredentialTestHook, loadCredentials } from ${JSON.stringify(modulePath)};
      installCredentialTestHook(async (seam) => {
        if (seam !== "quarantine-copy-durable") return;
        await fs.writeFile(${JSON.stringify(writerOwnedPath)}, "owned");
        await Bun.stdin.text();
      });
      await loadCredentials();
    `],
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let childReleased = false;
  const releaseChild = () => {
    if (childReleased) return;
    childReleased = true;
    child.stdin.end();
  };
  const childStdout = new Response(child.stdout).text();
  const childStderr = new Response(child.stderr).text();
  const warnings: string[] = [];
  const oldWarn = console.warn;
  let clearing: Promise<void> | undefined;
  let childResult: { childExit: number; stdout: string; stderr: string } | undefined;
  try {
    await Promise.race([
      waitUntil(() => fs.lstat(writerOwnedPath).then(() => true, () => false), "child-owned credential lock"),
      child.exited.then(async (code) => {
        throw new Error(`credential writer exited before owning the lock (${code}): ${await childStderr}`);
      }),
    ]);

    let contentionObserved!: () => void;
    const contended = new Promise<void>((resolve) => { contentionObserved = resolve; });
    restoreHook = installCredentialTestHook((seam) => {
      if (seam === "lock-contended") contentionObserved();
    });
    console.warn = (value?: unknown) => void warnings.push(String(value));
    clearing = clearCredentials();
    await beforeDeadline(Promise.race([
      contended,
      clearing.then(() => { throw new Error("logout completed before observing the in-flight writer"); }),
    ]), "logout contention");
    releaseChild();
    await clearing;
  } finally {
    releaseChild();
    try {
      await beforeDeadline(child.exited, "credential writer exit", 2_000);
    } catch {
      if (child.exitCode === null) child.kill();
    }
    const [childExit, stdout, stderr] = await Promise.all([child.exited, childStdout, childStderr]);
    childResult = { childExit, stdout, stderr };
    await clearing?.catch(() => {});
    console.warn = oldWarn;
  }
  expect(childResult).toEqual({ childExit: 0, stdout: "", stderr: "" });
  expect(warnings.join("\n")).not.toContain("destructive-recovery override");
  await expect(fs.lstat(credentialPath())).rejects.toThrow();
  await expect(fs.lstat(lockPath())).rejects.toThrow();
}, 20_000);

test("future main marker and a post-acquisition fence failure use the logout-only override", async () => {
  for (const mode of ["future", "post-acquisition"] as const) {
    await fs.rm(path.join(home, ".rbox"), { recursive: true, force: true });
    await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
    await fs.writeFile(credentialPath(), JSON.stringify({ v: 1, ...credential }), { mode: 0o600 });
    if (mode === "future") {
      const future = { v: 1, pid: process.pid, processStart: "1", acquiredAt: new Date(Date.now() + 60_000).toISOString(), nonce: "e".repeat(32) };
      await fs.writeFile(lockPath(), JSON.stringify(future), { mode: 0o600 });
    } else {
      let mainPublished = false;
      restoreHook = installCredentialTestHook((seam, context) => {
        if (seam === "marker-after-link" && context.markerPath === lockPath()) mainPublished = true;
        if (mainPublished && seam === "marker-before-link" && context.markerPath === `${lockPath()}.fence`) {
          throw new Error("injected post-acquisition fence failure");
        }
      });
    }
    const warnings: string[] = [];
    const oldWarn = console.warn;
    console.warn = (value?: unknown) => void warnings.push(String(value));
    try {
      await clearCredentials();
    } finally {
      console.warn = oldWarn;
    }
    expect(warnings.join("\n")).toContain("destructive-recovery override");
    await expect(fs.lstat(credentialPath())).rejects.toThrow();
    restoreHook?.();
    restoreHook = undefined;
  }
});

test("logout override refuses unsafe parent mode without deleting evidence", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  await fs.writeFile(credentialPath(), JSON.stringify({ v: 1, ...credential }), { mode: 0o600 });
  await fs.writeFile(lockPath(), "tampered", { mode: 0o600 });
  await fs.chmod(path.dirname(credentialPath()), 0o722);
  try {
    await expect(clearCredentials()).rejects.toThrow(/could not be cleared safely/);
    expect(await fs.readFile(credentialPath(), "utf8")).toContain("tok_secret");
    expect(await fs.readFile(lockPath(), "utf8")).toBe("tampered");
  } finally {
    await fs.chmod(path.dirname(credentialPath()), 0o700);
  }
});

test("logout override seam swap is detected before deleting any exact target", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  const credentialRaw = JSON.stringify({ v: 1, ...credential });
  await fs.writeFile(credentialPath(), credentialRaw, { mode: 0o600 });
  await fs.writeFile(lockPath(), "tampered", { mode: 0o600 });
  const replacement = `${credentialPath()}.replacement`;
  restoreHook = installCredentialTestHook(async (seam) => {
    if (seam !== "logout-override-before-delete") return;
    await fs.rename(credentialPath(), replacement);
    await fs.writeFile(credentialPath(), "seam-replacement", { mode: 0o600 });
  });
  await expect(clearCredentials()).rejects.toThrow(/could not be cleared safely/);
  expect(await fs.readFile(replacement, "utf8")).toBe(credentialRaw);
  expect(await fs.readFile(credentialPath(), "utf8")).toBe("seam-replacement");
  expect(await fs.readFile(lockPath(), "utf8")).toBe("tampered");
});

test("concurrent republish after override is non-definitive and a second logout clears it", async () => {
  await fs.mkdir(path.dirname(credentialPath()), { mode: 0o700 });
  await fs.writeFile(credentialPath(), JSON.stringify({ v: 1, ...credential }), { mode: 0o600 });
  await fs.writeFile(lockPath(), "tampered", { mode: 0o600 });
  let republished = false;
  restoreHook = installCredentialTestHook(async (seam) => {
    if (seam !== "logout-override-after-delete") return;
    republished = true;
    await fs.writeFile(credentialPath(), JSON.stringify({ v: 1, ...credential, token: "republished" }), { mode: 0o600 });
  });
  const warnings: string[] = [];
  const oldWarn = console.warn;
  console.warn = (value?: unknown) => void warnings.push(String(value));
  try {
    await clearCredentials();
  } finally {
    console.warn = oldWarn;
    restoreHook();
    restoreHook = undefined;
  }
  expect(republished).toBe(true);
  expect(await fs.readFile(credentialPath(), "utf8")).toContain("republished");
  expect(warnings.join("\n")).toContain("run `rbox logout` again");
  await clearCredentials();
  await expect(fs.lstat(credentialPath())).rejects.toThrow();
});

test("the destructive override capability is unreachable from load and save", async () => {
  let called = false;
  restoreHook = installCredentialTestHook((seam) => {
    if (seam === "logout-override-after-delete") called = true;
  });
  await saveCredentials(credential);
  expect((await loadCredentials()).state).toBe("valid");
  await fs.writeFile(credentialPath(), "{login-preflight-evidence", { mode: 0o600 });
  await saveCredentials(credential);
  expect(called).toBe(false);
});
