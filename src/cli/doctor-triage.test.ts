import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  observeDaemon,
  readTriageInputs,
  renderWorkspaceTriage,
  triageWorkspace,
  type TriageFinding,
  type TriageInputs,
} from "./doctor-triage.js";
import { checkManifestChain, collectDoctorContext, doctorCmd, type DoctorChecks } from "./doctor-cmd.js";
import type { DaemonObservation } from "./doctor-evidence.js";
import { saveStateUnsafeLegacyOrTest, syncStreamId } from "./config.js";
import { daemonPidPath, daemonRuntimeDir, daemonStatusPath } from "./rbox-paths.js";
import { lockingHealthPath } from "./sync-mutex.js";
import { saveCredentials } from "./credentials.js";
import { ManifestChainError } from "../engine/index.js";
import type { SubscribePlan } from "./subscribe-cmd.js";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const LIVE_PID = 4242;
const BOOT = "boot-live";

let home: string;
let root: string;
const originalHome = process.env.HOME;
const origFetch = globalThis.fetch;

const healthyChecks = (): DoctorChecks => ({
  credentials: { ok: true, label: "credentials", message: "authenticated" },
  enrollment: { ok: true, label: "encryption", message: "device key and master key present" },
  device: { ok: true, label: "device", message: "device dev_1" },
  daemon: { ok: true, label: "background sync", message: "running (pid 1)", status: "running" },
  remote: { ok: true, label: "remote", message: "reachable" },
  version: { ok: true, label: "version", message: "up to date", current: "1.9.0", latest: "1.9.0" },
  state: { ok: true, label: "state", message: "ok" },
  crypto: { ok: true, label: "crypto workers", message: "idle", status: "idle" },
  locking: { ok: true, label: "locking", message: "ok", status: "ok" },
  git: { ok: true, label: "git", message: "supported", status: "supported" },
  chain: { ok: true, label: "manifest chain", message: "head 3" },
});

const STOPPED: DaemonObservation = { running: false, stale: false, ownsRoot: false };

const inputs = (over: Partial<TriageInputs> = {}): TriageInputs => ({
  root,
  checks: healthyChecks(),
  deferrals: [],
  ambient: { kind: "absent" },
  daemon: { running: true, stale: false, ownsRoot: true, pid: LIVE_PID, bootId: BOOT },
  adopt: { status: "none" },
  now: NOW,
  cliVersion: "1.9.0",
  ...over,
});

const workspaceConfig = () => ({
  schema: "e2ee/v1" as const,
  remoteWorkspaceId: "ws_1",
  projectId: "root",
  rootPath: root,
  remoteUrl: "https://api.rbox.to",
  token: "",
  deviceId: "dev_1",
});

/** Drive the single liveness/binding seam. A `boundTo` differing from this
 * root's workspace id reproduces a daemon that rebound elsewhere. */
function liveness(opts: { running: boolean; pid?: number; bootId?: string; boundTo?: string }) {
  return {
    daemonBindingStatus: (_root: string, workspaceId: string) => {
      const alive = opts.running
        ? { running: true, pid: opts.pid ?? LIVE_PID, bootId: opts.bootId ?? BOOT }
        : { running: false };
      const bound = opts.running ? opts.boundTo ?? workspaceId : undefined;
      return { alive, bound, stale: opts.running && bound !== undefined && bound !== workspaceId };
    },
  };
}

const findingById = (findings: TriageFinding[], id: string): TriageFinding | undefined =>
  findings.find((finding) => finding.id === id);

/** Account-level remedies are deliberately unscoped; everything else acts on a
 * specific folder and must carry it. */
const ACCOUNT_LEVEL = /^(rbox login|rbox upgrade|rbox key |rbox subscribe |rbox track |brew )/;

function deferral(over: Record<string, unknown> = {}): TriageInputs["deferrals"][number] {
  return {
    repo: "savvy-core",
    oldestDeferredSince: new Date(NOW - 20 * 3600_000).toISOString(),
    displayReason: "local-commits",
    displayLane: "apply",
    reasonSince: new Date(NOW - 20 * 3600_000).toISOString(),
    reasonLabel: "local commits",
    reasonText: "Local commits changed here.",
    repairText: "Stop Git mutation, then let normal sync retry.",
    remediationClass: "apply-resolvable",
    canResolve: true,
    canKeepMine: true,
    bytesChanged: false,
    ...over,
  } as TriageInputs["deferrals"][number];
}

async function writeActivity(body: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "state", "activity.json"), JSON.stringify(body));
}

async function writeDaemonRecords(opts: {
  statusBootId?: string;
  pidBootId?: string;
  status?: Record<string, unknown>;
}): Promise<void> {
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(daemonPidPath(root), `v2 ${LIVE_PID} ${opts.pidBootId ?? BOOT}\n`);
  await fs.writeFile(daemonStatusPath(root), JSON.stringify({
    schemaVersion: 1,
    state: "synced",
    heartbeatAt: new Date(NOW - 1_000).toISOString(),
    sequence: 1,
    lastSyncedAt: null,
    ...(opts.statusBootId === undefined ? {} : { bootId: opts.statusBootId }),
    ...opts.status,
  }));
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-triage-home-"));
  process.env.RBOX_HOME = home;
  process.env.HOME = home;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-triage-root-"));
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify(workspaceConfig()));
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  delete process.env.RBOX_HOME;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  process.exitCode = 0;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- happy path

test("a healthy workspace reports one plain-English all-clear and no findings", () => {
  const triage = triageWorkspace(inputs());
  expect(triage.healthy).toBe(true);
  expect(triage.findings).toEqual([]);
  expect(renderWorkspaceTriage(triage).join("\n")).toContain("Everything is syncing normally.");
});

// --------------------------------------------- HIGH 1: offline is not signed out

test("a VALID token during a network outage reports 'couldn't check', never signed-out", async () => {
  await saveCredentials({ token: "tok_valid", deviceId: "dev_1", remoteUrl: "https://api.rbox.to", accountId: "acct_1111111111111111" });
  globalThis.fetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  }) as typeof fetch;

  const ctx = await collectDoctorContext(root);
  // Producer proof: the credential check could not reach a verdict.
  expect(ctx.checks.credentials.ok).toBe(false);
  expect(ctx.checks.credentials.inconclusive).toBe(true);

  const triage = triageWorkspace(await readTriageInputs(root, ctx.checks, NOW));
  expect(findingById(triage.findings, "signed-out")).toBeUndefined();
  expect(findingById(triage.findings, "history-unreadable")).toBeUndefined();
  const offline = findingById(triage.findings, "service-unreachable");
  expect(offline?.problem).toContain("couldn't reach the sync service");
  expect(offline?.command).toBe(`cd ${root} && rbox doctor`);
});

test("a genuinely REJECTED token still reports signed-out, and not the offline finding", async () => {
  await saveCredentials({ token: "tok_stale", deviceId: "dev_1", remoteUrl: "https://api.rbox.to", accountId: "acct_1111111111111111" });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("/v1/account/status")) return new Response("no", { status: 401 });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const ctx = await collectDoctorContext(root);
  expect(ctx.checks.credentials.ok).toBe(false);
  expect(ctx.checks.credentials.inconclusive).toBeUndefined();
  expect(ctx.checks.remote.ok).toBe(true);

  const checks = { ...ctx.checks, version: { ok: true, label: "version", message: "up to date" }, chain: { ok: true, label: "manifest chain", message: "head 1" } };
  const triage = triageWorkspace(await readTriageInputs(root, checks, NOW));
  expect(findingById(triage.findings, "service-unreachable")).toBeUndefined();
  expect(findingById(triage.findings, "signed-out")?.command).toBe("rbox login");
});

test("a 5xx on the account check is inconclusive, not a rejected token", async () => {
  await saveCredentials({ token: "tok_valid", deviceId: "dev_1", remoteUrl: "https://api.rbox.to", accountId: "acct_1111111111111111" });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("/v1/account/status")) return new Response("boom", { status: 503 });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const ctx = await collectDoctorContext(root);
  expect(ctx.checks.credentials.inconclusive).toBe(true);
  const triage = triageWorkspace(await readTriageInputs(root, ctx.checks, NOW));
  expect(findingById(triage.findings, "signed-out")).toBeUndefined();
  expect(findingById(triage.findings, "service-unreachable")).toBeDefined();
});

// ---- R2 HIGH 1: an inconclusive check suppresses ONLY its own claim ----

test("a REJECTED token still reports signed-out even when the version lookup was inconclusive", async () => {
  await saveCredentials({ token: "tok_stale", deviceId: "dev_1", remoteUrl: "https://api.rbox.to", accountId: "acct_1111111111111111" });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("/v1/account/status")) return new Response("no", { status: 401 });
    // The release manifest is what fails to answer here.
    if (url.endsWith("/version") || url.endsWith("/version.sig")) throw new Error("connection reset");
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const ctx = await collectDoctorContext(root);
  // Producer proof of the exact reported combination.
  expect(ctx.checks.credentials.ok).toBe(false);
  expect(ctx.checks.credentials.inconclusive).toBeUndefined();
  expect(ctx.checks.version.inconclusive).toBe(true);

  const findings = triageWorkspace(await readTriageInputs(root, ctx.checks, NOW)).findings;
  expect(findingById(findings, "signed-out")?.command).toBe("rbox login");
  // The unverified check is still disclosed — it just cannot veto the rejection.
  const offline = findingById(findings, "service-unreachable");
  expect(offline?.problem).toContain("whether an update is available");
  expect(offline?.problem).not.toContain("your sign-in");
});

test("a VERIFIED chain error still reports unreadable history when the sign-in lookup was inconclusive", async () => {
  const chain = await checkManifestChain({
    chainDiagnostic: async () => {
      throw new ManifestChainError("link decrypt failed");
    },
  });
  const checks = healthyChecks();
  checks.chain = chain;
  checks.credentials = { ok: false, inconclusive: true, label: "credentials", message: "could not verify token" };
  expect(chain.inconclusive).toBeUndefined();

  const findings = triageWorkspace(inputs({ checks })).findings;
  expect(findingById(findings, "history-unreadable")?.command).toBe(`cd ${root} && rbox recover --repair-chain`);
  expect(findingById(findings, "signed-out")).toBeUndefined();
  expect(findingById(findings, "service-unreachable")?.problem).toContain("your sign-in");
});

test("a PROVEN sign-in failure does still suppress the chain error it would explain", async () => {
  const chain = await checkManifestChain({
    chainDiagnostic: async () => {
      throw new ManifestChainError("link decrypt failed");
    },
  });
  const checks = healthyChecks();
  checks.chain = chain;
  checks.credentials = { ok: false, label: "credentials", message: "token rejected (401)" };
  const findings = triageWorkspace(inputs({ checks })).findings;
  expect(findingById(findings, "signed-out")).toBeDefined();
  expect(findingById(findings, "history-unreadable")).toBeUndefined();
});

// ------------------------- HIGH 2: a transport error is not proven corruption

test("a transport failure on the chain diagnostic is inconclusive and claims no corruption", async () => {
  const check = await checkManifestChain({
    chainDiagnostic: async () => {
      throw new Error("fetch failed");
    },
  });
  expect(check.ok).toBe(false);
  expect(check.inconclusive).toBe(true);
  expect(findingById(triageWorkspace(inputs({ checks: { ...healthyChecks(), chain: check } })).findings, "history-unreadable")).toBeUndefined();
});

test("a VERIFIED chain error is reported as unreadable history with the repair command", async () => {
  const check = await checkManifestChain({
    chainDiagnostic: async () => {
      throw new ManifestChainError("link decrypt failed");
    },
  });
  expect(check.ok).toBe(false);
  expect(check.inconclusive).toBeUndefined();
  expect(findingById(triageWorkspace(inputs({ checks: { ...healthyChecks(), chain: check } })).findings, "history-unreadable")?.command)
    .toBe(`cd ${root} && rbox recover --repair-chain`);
});

// ---------------------- HIGH 3: stopped-daemon halt/quota residue is dropped

test("a stopped daemon's halt and quota residue is read but never reported", async () => {
  await writeActivity({
    at: new Date(NOW).toISOString(),
    halt: {
      at: new Date(NOW).toISOString(),
      reason: "pull would delete 900 of 1000 tracked files — refusing (mass-delete guard).",
      count: 1,
      op: "pull",
      typedReason: { kind: "mass-delete", op: "pull" },
    },
    outOfStorage: { at: new Date(NOW).toISOString(), kind: "storage" },
  });
  const collected = await readTriageInputs(root, healthyChecks(), NOW, liveness({ running: false }));
  // Producer proof: the residue IS on disk and WAS read — the gate is what drops it.
  expect(collected.activity?.halt?.typedReason?.kind).toBe("mass-delete");
  expect(collected.activity?.outOfStorage).toBeDefined();
  expect(collected.daemon.ownsRoot).toBe(false);

  const triage = triageWorkspace(collected);
  expect(findingById(triage.findings, "halt:mass-delete")).toBeUndefined();
  expect(findingById(triage.findings, "quota-storage")).toBeUndefined();
});

test("a daemon bound to another workspace also drops halt residue", async () => {
  await writeActivity({
    at: new Date(NOW).toISOString(),
    halt: {
      at: new Date(NOW).toISOString(),
      reason: "pull would delete 900 of 1000 tracked files",
      count: 1,
      op: "pull",
      typedReason: { kind: "mass-delete", op: "pull" },
    },
  });
  await writeDaemonRecords({ statusBootId: BOOT, pidBootId: BOOT });
  const collected = await readTriageInputs(root, healthyChecks(), NOW, liveness({ running: true, boundTo: "ws_elsewhere" }));
  // Producer proof: the halt IS on disk and the daemon IS alive — the binding
  // mismatch alone is what makes the residue unowned.
  expect(collected.activity?.halt).toBeDefined();
  expect(collected.daemon.running).toBe(true);
  expect(collected.daemon.stale).toBe(true);
  expect(collected.daemon.ownsRoot).toBe(false);
  const findings = triageWorkspace(collected).findings;
  expect(findingById(findings, "halt:mass-delete")).toBeUndefined();
  expect(findingById(findings, "daemon-stale-binding")).toBeDefined();
});

// ---- R2 HIGH 3: ownership is ONE fresh, root-aware observation ----

test("a pid that is alive but is not this root's daemon leaves residue unowned", async () => {
  // PID reuse, reproduced against the REAL observation: the pidfile names a live
  // process that is not an rbox daemon for this root at all.
  await writeActivity({
    at: new Date(NOW).toISOString(),
    halt: {
      at: new Date(NOW).toISOString(),
      reason: "pull would delete 900 of 1000 tracked files",
      count: 1,
      op: "pull",
      typedReason: { kind: "mass-delete", op: "pull" },
    },
    outOfStorage: { at: new Date(NOW).toISOString(), kind: "storage" },
  });
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(daemonPidPath(root), `v2 ${process.pid} ${BOOT}\n`);

  const collected = await readTriageInputs(root, healthyChecks(), NOW);
  expect(collected.activity?.halt).toBeDefined();
  expect(collected.daemon.running).toBe(false);
  expect(collected.daemon.ownsRoot).toBe(false);

  const findings = triageWorkspace(collected).findings;
  expect(findingById(findings, "halt:mass-delete")).toBeUndefined();
  expect(findingById(findings, "quota-storage")).toBeUndefined();
  expect(findingById(findings, "daemon-stopped")).toBeDefined();
});

test("a live daemon for a PREFIX SIBLING root does not claim this one", async () => {
  // Round-3 defect, reproduced end to end through the real `ps` read: ownership
  // used a substring test, so a daemon for `<root>-old` owned `<root>` — and a
  // reused pid then attributed that workspace's halt to this one.
  const sibling = `${root}-old`;
  const squatter = Bun.spawn(["sh", "-c", "sleep 30", "__daemon-run", sibling], { stdout: "ignore", stderr: "ignore" });
  try {
    // The SAME live pid is recorded for both roots — the pid reuse this defect
    // needed. Only the command line can tell the two workspaces apart.
    for (const owner of [root, sibling]) {
      await fs.mkdir(daemonRuntimeDir(owner), { recursive: true });
      await fs.writeFile(daemonPidPath(owner), `v2 ${squatter.pid} ${BOOT}\n`);
    }
    await writeActivity({
      at: new Date(NOW).toISOString(),
      halt: {
        at: new Date(NOW).toISOString(),
        reason: "pull would delete 900 of 1000 tracked files",
        count: 1,
        op: "pull",
        typedReason: { kind: "mass-delete", op: "pull" },
      },
    });
    expect(observeDaemon(root).ownsRoot).toBe(false);
    // ...and the same process IS still recognized as the sibling's own daemon.
    expect(observeDaemon(sibling).running).toBe(true);

    const collected = await readTriageInputs(root, healthyChecks(), NOW);
    expect(collected.activity?.halt).toBeDefined();
    expect(findingById(triageWorkspace(collected).findings, "halt:mass-delete")).toBeUndefined();
  } finally {
    squatter.kill();
    await squatter.exited;
  }
});

test("a live rbox daemon for ANOTHER root does not claim this one", async () => {
  // Same pid, real `ps` inspection: the command line names a different root, so
  // the root-scoped observation refuses it (bare isDaemonProcess would not).
  const other = path.join(path.dirname(root), "some-other-workspace");
  const squatter = Bun.spawn(["sh", "-c", "sleep 30", "__daemon-run", other], { stdout: "ignore", stderr: "ignore" });
  try {
    await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
    await fs.writeFile(daemonPidPath(root), `v2 ${squatter.pid} ${BOOT}\n`);
    await writeActivity({
      at: new Date(NOW).toISOString(),
      halt: {
        at: new Date(NOW).toISOString(),
        reason: "pull would delete 900 of 1000 tracked files",
        count: 1,
        op: "pull",
        typedReason: { kind: "mass-delete", op: "pull" },
      },
    });
    const collected = await readTriageInputs(root, healthyChecks(), NOW);
    expect(collected.daemon.ownsRoot).toBe(false);
    expect(findingById(triageWorkspace(collected).findings, "halt:mass-delete")).toBeUndefined();
  } finally {
    squatter.kill();
    await squatter.exited;
  }
});

test("ownership comes from the triage-time observation, not the earlier check verdict", async () => {
  await writeActivity({
    at: new Date(NOW).toISOString(),
    halt: {
      at: new Date(NOW).toISOString(),
      reason: "pull would delete 5 of 50 tracked files",
      count: 1,
      op: "pull",
      typedReason: { kind: "mass-delete", op: "pull" },
    },
  });
  // A daemon that rebound to THIS root after collection captured "stale": the
  // stale check verdict must not suppress the halt its live daemon is reporting.
  const staleChecks = healthyChecks();
  staleChecks.daemon = { ok: false, label: "background sync", message: "stale", status: "stale" };
  const collected = await readTriageInputs(root, staleChecks, NOW, liveness({ running: true }));
  expect(collected.daemon.ownsRoot).toBe(true);
  const findings = triageWorkspace(collected).findings;
  expect(findingById(findings, "halt:mass-delete")).toBeDefined();
  expect(findingById(findings, "daemon-stale-binding")).toBeUndefined();
});

// ------------------- HIGH 4/5: ambient state bound to the live daemon incarnation

test("a pull-only claim requires the status record to match the live pidfile incarnation", async () => {
  await writeDaemonRecords({ statusBootId: "boot-other", pidBootId: BOOT, status: { mode: "pull-only", daemonVersion: "1.9.0" } });
  const mismatched = await readTriageInputs(root, healthyChecks(), NOW, liveness({ running: true }));
  expect(mismatched.daemon.bootId).toBe(BOOT);
  expect(mismatched.ambient.kind).toBe("ok");
  expect(findingById(triageWorkspace(mismatched).findings, "pull-only")).toBeUndefined();

  await writeDaemonRecords({ statusBootId: BOOT, pidBootId: BOOT, status: { mode: "pull-only", daemonVersion: "1.9.0" } });
  const bound = await readTriageInputs(root, healthyChecks(), NOW, liveness({ running: true }));
  const pullOnly = findingById(triageWorkspace(bound).findings, "pull-only");
  expect(pullOnly?.command).toBe(`cd ${root} && rbox start --read-write`);
  // MEDIUM 14: pull-only still APPLIES remote changes locally.
  expect(pullOnly?.safety).toContain("DO keep downloading and applying here");
});

test("a record from a PREVIOUS boot yields no watcher and no version-skew finding either", async () => {
  // The exact reproduction from review round 2: an old-boot record that used to
  // produce watcher-degraded + daemon-version-skew because only `mode` was gated.
  await writeDaemonRecords({
    statusBootId: "boot-previous",
    pidBootId: BOOT,
    status: { state: "attention", attentionReason: "watcher-degraded", mode: "pull-only", daemonVersion: "1.0.0" },
  });
  const old = await readTriageInputs(root, healthyChecks(), NOW, liveness({ running: true }));
  // Producer proof: the record parsed, the daemon is live and owns this root —
  // the boot-id mismatch is the only thing standing between them.
  expect(old.ambient.kind).toBe("ok");
  expect(old.daemon.ownsRoot).toBe(true);
  expect(old.daemon.bootId).toBe(BOOT);

  const findings = triageWorkspace(old).findings;
  expect(findingById(findings, "watcher-degraded")).toBeUndefined();
  expect(findingById(findings, "daemon-version-skew")).toBeUndefined();
  expect(findingById(findings, "ownership-lost")).toBeUndefined();
  expect(findingById(findings, "pull-only")).toBeUndefined();
});

test("a legacy record with no boot id at all is not trusted", async () => {
  await writeDaemonRecords({
    pidBootId: BOOT,
    status: { state: "attention", attentionReason: "watcher-degraded", daemonVersion: "1.0.0" },
  });
  const legacy = await readTriageInputs(root, healthyChecks(), NOW, liveness({ running: true }));
  expect(legacy.ambient.kind).toBe("ok");
  expect(findingById(triageWorkspace(legacy).findings, "watcher-degraded")).toBeUndefined();
});

test("a dead daemon's fresh record produces no watcher or version finding", async () => {
  await writeDaemonRecords({
    statusBootId: BOOT,
    pidBootId: BOOT,
    status: { state: "attention", attentionReason: "watcher-degraded", daemonVersion: "1.0.0" },
  });
  const dead = await readTriageInputs(root, healthyChecks(), NOW, liveness({ running: false }));
  expect(dead.ambient.kind).toBe("ok");
  const findings = triageWorkspace(dead).findings;
  expect(findingById(findings, "watcher-degraded")).toBeUndefined();
  expect(findingById(findings, "daemon-version-skew")).toBeUndefined();
});

test("a future-dated heartbeat is not trusted as live state", async () => {
  await writeDaemonRecords({
    statusBootId: BOOT,
    pidBootId: BOOT,
    status: { state: "attention", attentionReason: "watcher-degraded", heartbeatAt: new Date(NOW + 3 * 3600_000).toISOString() },
  });
  const skewed = await readTriageInputs(root, healthyChecks(), NOW, liveness({ running: true }));
  expect(skewed.ambient.kind).toBe("ok");
  expect(findingById(triageWorkspace(skewed).findings, "watcher-degraded")).toBeUndefined();
});

test("a live, boot-bound, fresh record does surface the degraded watcher and version skew", async () => {
  await writeDaemonRecords({
    statusBootId: BOOT,
    pidBootId: BOOT,
    status: { state: "attention", attentionReason: "watcher-degraded", daemonVersion: "1.0.0" },
  });
  const live = await readTriageInputs(root, healthyChecks(), NOW, liveness({ running: true }));
  const findings = triageWorkspace(live).findings;
  expect(findingById(findings, "watcher-degraded")?.command).toBe(`cd ${root} && rbox stop && rbox start`);
  expect(findingById(findings, "daemon-version-skew")?.command).toBe("rbox upgrade");
});

// ------------------------------------------- HIGH 6: remedies carry their root

test("every workspace-scoped remedy carries its own workspace", () => {
  const checks = healthyChecks();
  checks.state = { ok: false, label: "state", message: "not valid JSON", status: "malformed" };
  checks.locking = { ok: false, label: "locking", message: "starved", status: "starved" };
  const triage = triageWorkspace(inputs({
    checks,
    daemon: STOPPED,
    adopt: { status: "active", phase: "scanning", journalId: "j1" },
    deferrals: [deferral()],
  }));
  const commands = triage.findings.flatMap((finding) => (finding.command ? [finding.command] : []));
  expect(commands.length).toBeGreaterThan(4);
  for (const command of commands) {
    if (ACCOUNT_LEVEL.test(command)) continue;
    expect(command.startsWith(`cd ${root} && `)).toBe(true);
  }
});

// ------------------------------------------ HIGH 7: scoped mass-delete consent

test("a pull-side mass-delete halt consents to that pull only, and names the count", async () => {
  await writeActivity({
    at: new Date(NOW).toISOString(),
    halt: {
      at: new Date(NOW).toISOString(),
      reason: "pull would delete 812 of 1004 tracked files — refusing (mass-delete guard).",
      count: 1,
      op: "pull",
      typedReason: { kind: "mass-delete", op: "pull" },
    },
  });
  await writeDaemonRecords({ statusBootId: BOOT, pidBootId: BOOT });
  const live = await readTriageInputs(root, healthyChecks(), NOW, liveness({ running: true }));
  expect(live.daemon.ownsRoot).toBe(true);
  const finding = findingById(triageWorkspace(live).findings, "halt:mass-delete");
  expect(finding?.command).toBe(`cd ${root} && rbox pull --allow-mass-delete`);
  expect(finding?.command).not.toContain("rbox sync");
  expect(finding?.problem).toContain("812 of your 1004 synced files");
  expect(finding?.problem).toContain("from this machine");
  expect(finding?.safety).toContain("CONFIRMS that local deletion");
});

test("a push-side mass-delete halt consents to that push only", async () => {
  await writeActivity({
    at: new Date(NOW).toISOString(),
    halt: {
      at: new Date(NOW).toISOString(),
      reason: "push would delete 40 of 50 tracked files — refusing (mass-delete guard).",
      count: 1,
      op: "push",
      typedReason: { kind: "mass-delete", op: "push" },
    },
  });
  await writeDaemonRecords({ statusBootId: BOOT, pidBootId: BOOT });
  const live = await readTriageInputs(root, healthyChecks(), NOW, liveness({ running: true }));
  const finding = findingById(triageWorkspace(live).findings, "halt:mass-delete");
  expect(finding?.command).toBe(`cd ${root} && rbox push --allow-mass-delete`);
  expect(finding?.problem).toContain("everywhere else you sync");
});

// -------------------- HIGH 8: no remedy that cannot run against the diagnosed state

test("malformed local state is honest that rbox cannot repair it, and never offers rbox recover", async () => {
  await fs.writeFile(path.join(root, ".rbox", "state.json"), "{ not json");
  const ctx = await collectDoctorContext(root);
  expect(ctx.checks.state.ok).toBe(false);
  expect(ctx.checks.state.status).toBe("malformed");

  const finding = findingById(triageWorkspace(await readTriageInputs(root, ctx.checks, NOW)).findings, "state-unreadable");
  expect(finding?.problem).toContain("rbox cannot repair this by itself");
  expect(finding?.command).toBe(`cd ${root} && rbox doctor --report`);
  expect(finding?.command).not.toContain("rbox recover");
  // R2 MEDIUM 4: the PROSE remedy is scoped like the structured ones.
  expect(finding?.safety).toContain(`cd ${root} && rbox setup`);
  expect(finding?.safety).not.toMatch(/[^&] `rbox setup`/);
});

test("a state plane from a newer rbox is reported end to end and never advises deleting it", async () => {
  await fs.writeFile(path.join(root, ".rbox", "state.json"), `RBOX-SQLITE-AUTHORITY-v1\n${"a".repeat(32)}\n`);
  const ctx = await collectDoctorContext(root);
  expect(ctx.checks.state.ok).toBe(false);
  expect(ctx.checks.state.status).toBe("format-too-new");
  expect(ctx.checks.state.hint).not.toContain("delete it");

  const finding = findingById(triageWorkspace(await readTriageInputs(root, ctx.checks, NOW)).findings, "state-format-too-new");
  expect(finding?.severity).toBe("blocked");
  expect(finding?.problem).toContain("newer version of rbox");
  expect(finding?.command).toBe("rbox upgrade");
  // The only mention of deletion anywhere in the finding is the instruction NOT to.
  expect(`${finding?.problem} ${finding?.safety} ${finding?.command}`.match(/delet/gi)?.length).toBe(1);
  expect(finding?.safety).toContain("Do not delete");
});

test("a foreign occupant of the upgrade reserve is reported without threatening it", () => {
  const checks = healthyChecks();
  checks.reserve = { ok: false, label: "upgrade reserve", message: "not rbox's own reserved space (foreign-workspace)", status: "reserve-foreign" };
  const finding = findingById(triageWorkspace(inputs({ checks })).findings, "state-reserve-foreign");
  expect(finding?.severity).toBe("attention");
  expect(finding?.safety).toContain("will not open, shrink, or delete");
});

test("a state file from another workspace gets its own finding, also without rbox recover", () => {
  const checks = healthyChecks();
  checks.state = { ok: false, label: "state", message: "different stream", status: "stream-mismatch" };
  const finding = findingById(triageWorkspace(inputs({ checks })).findings, "state-belongs-elsewhere");
  expect(finding?.problem).toContain("belong to a different workspace");
  expect(finding?.command).not.toContain("rbox recover");
});

// -------------------------------------------------- MEDIUM 9: quota remedies

test("quota remedies name a real plan, and no_plan is distinguished from out-of-storage", () => {
  const noPlan = findingById(
    triageWorkspace(inputs({
      activity: { at: new Date(NOW).toISOString(), outOfStorage: { at: new Date(NOW).toISOString(), kind: "storage", reason: "no_plan" } },
    })).findings,
    "quota-no-plan",
  );
  const full = findingById(
    triageWorkspace(inputs({
      activity: { at: new Date(NOW).toISOString(), outOfStorage: { at: new Date(NOW).toISOString(), kind: "storage" } },
    })).findings,
    "quota-storage",
  );
  expect(noPlan?.problem).toContain("not on a plan yet");
  expect(full?.problem).toContain("out of storage");
  // Compile-time proof that both arguments are plans `rbox subscribe` accepts.
  const offered: SubscribePlan[] = ["solo", "pro"];
  const valid = offered.map((plan) => `rbox subscribe ${plan}`);
  expect(valid).toContain(noPlan!.command!);
  expect(valid).toContain(full!.command!);
});

// --------------------------------------- MEDIUM 11: degraded locking ≠ contention

test("degraded locking is described as identity loss, not contention, with no restart remedy", async () => {
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  await fs.writeFile(lockingHealthPath(root), JSON.stringify({ status: "degraded-unlocked", reason: "identity-unavailable" }));
  const ctx = await collectDoctorContext(root);
  expect(ctx.checks.locking.status).toBe("degraded-unlocked");

  const findings = triageWorkspace(await readTriageInputs(root, ctx.checks, NOW)).findings;
  expect(findingById(findings, "sync-lock-contention")).toBeUndefined();
  const degraded = findingById(findings, "locking-degraded");
  expect(degraded?.problem).toContain("could not identify this machine");
  expect(degraded?.command).not.toContain("rbox stop");
});

test("real lock starvation keeps the contention diagnosis and the restart remedy", () => {
  const checks = healthyChecks();
  checks.locking = { ok: false, label: "locking", message: "starved", status: "starved" };
  expect(findingById(triageWorkspace(inputs({ checks })).findings, "sync-lock-contention")?.command)
    .toBe(`cd ${root} && rbox stop && rbox start`);
});

// ------------------------------- MEDIUM 13: the triage read really is read-only

test("readTriageInputs does not touch state.json even with a standing reset journal", async () => {
  const cfg = workspaceConfig();
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: 1,
    lastSyncedManifest: { files: {} },
    repoRecords: {
      "savvy-core": {
        deferrals: { apply: { lane: "apply", reason: "local-commits", deferredSince: new Date(NOW - 26 * 3600_000).toISOString() } },
      },
    },
  } as never);
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "state", "reset-v1.json"), JSON.stringify({ v: 1, phase: "prepared" }));

  const statePath = path.join(root, ".rbox", "state.json");
  const before = await fs.readFile(statePath, "utf8");
  const beforeStat = await fs.stat(statePath);

  const collected = await readTriageInputs(root, healthyChecks(), NOW);
  expect(collected.deferrals.map((d) => d.repo)).toEqual(["savvy-core"]);

  expect(await fs.readFile(statePath, "utf8")).toBe(before);
  expect((await fs.stat(statePath)).mtimeMs).toBe(beforeStat.mtimeMs);
  // The journal is loadState's mutation trigger; it must survive untouched.
  expect(await fs.readFile(path.join(root, ".rbox", "state", "reset-v1.json"), "utf8")).toContain("prepared");
});

test("a state file belonging to another stream yields no deferrals rather than a rebaseline", async () => {
  await saveStateUnsafeLegacyOrTest(root, {
    stream: "https://api.rbox.to::ws_other::root",
    lastSyncedSequence: 1,
    lastSyncedManifest: { files: {} },
    repoRecords: {
      other: { deferrals: { apply: { lane: "apply", reason: "local-commits", deferredSince: new Date(NOW).toISOString() } } },
    },
  } as never);
  const collected = await readTriageInputs(root, healthyChecks(), NOW);
  expect(collected.deferrals).toEqual([]);
});

// ----------------------------------------------- MEDIUM 14: safety copy honesty

test("only proven-healthy deferral classes claim the repository is healthy", () => {
  const healthy = findingById(triageWorkspace(inputs({ deferrals: [deferral()] })).findings, "git-paused:savvy-core");
  expect(healthy?.safety).toContain("Your repository is healthy");
  expect(healthy?.command).toBe(`cd ${root} && rbox git resolve savvy-core keep-mine`);

  for (const reason of ["unreadable", "conflict", "unsupported", "ref-read-unreadable"]) {
    const risky = findingById(
      triageWorkspace(inputs({
        deferrals: [deferral({ displayReason: reason, reasonLabel: reason, remediationClass: "apply-unavailable", canResolve: false, canKeepMine: false })],
      })).findings,
      "git-paused:savvy-core",
    );
    expect(risky?.safety).not.toContain("repository is healthy");
    expect(risky?.safety).toContain("could not read or reconcile");
    expect(risky?.command).toBe(`cd ${root} && rbox git deferrals --brief`);
  }
});

// ------------------------------------------------------------- ordering + json

test("blocked findings sort ahead of attention, and advisories sort last", () => {
  const checks = healthyChecks();
  checks.enrollment = { ok: false, label: "encryption", message: "device key is missing" };
  checks.version = { ok: false, label: "version", message: "update available", latest: "9.9.9" };
  const triage = triageWorkspace(inputs({ checks, daemon: STOPPED }));
  expect(triage.findings.map((f) => f.id)).toEqual(["encryption-key", "daemon-stopped", "update-available"]);
  expect(triage.healthy).toBe(false);
  expect(renderWorkspaceTriage(triage).join("\n")).toContain("2 things need your attention.");
});

test("an unfinished move-in is blocking and scoped", () => {
  const finding = findingById(
    triageWorkspace(inputs({ adopt: { status: "active", phase: "scanning", journalId: "j1" } })).findings,
    "adopt-incomplete",
  );
  expect(finding?.severity).toBe("blocked");
  expect(finding?.command).toBe(`cd ${root} && rbox adopt status`);
});

test("doctor --json emits the same findings machine-readably, and refuses --report", async () => {
  const origWrite = process.stdout.write.bind(process.stdout);
  const written: string[] = [];
  globalThis.fetch = (async () => {
    throw new Error("offline in test");
  }) as typeof fetch;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await doctorCmd(root, { report: false, yes: false, json: true, now: NOW });
  } finally {
    process.stdout.write = origWrite;
    process.exitCode = 0;
  }
  const payload = JSON.parse(written.join("")) as {
    schemaVersion: number;
    scope: string;
    root: string;
    healthy: boolean;
    findings: TriageFinding[];
  };
  expect(payload.schemaVersion).toBe(1);
  expect(payload.scope).toBe("workspace");
  expect(payload.root).toBe(path.resolve(root));
  // Offline: the machine-readable twin makes the same "couldn't check" call...
  expect(payload.findings.some((f) => f.id === "service-unreachable")).toBe(true);
  // ...without suppressing a definitive local fact (no credentials on disk at
  // all is proven, not inconclusive), and without inventing corruption.
  expect(payload.findings.some((f) => f.id === "signed-out")).toBe(true);
  expect(payload.findings.some((f) => f.id === "history-unreadable")).toBe(false);
  for (const finding of payload.findings) {
    expect(finding.problem.length).toBeGreaterThan(0);
    expect(finding.safety.length).toBeGreaterThan(0);
  }
  await expect(doctorCmd(root, { report: true, yes: true, json: true })).rejects.toThrow("--json prints the findings only");
});
