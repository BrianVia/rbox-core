import { afterEach, describe, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineFlow, type FlowDefinition } from "./flow.js";
import {
  classify, exitCodeForOutcomes, loadFlows, pruneRunDirs, runFlow, runWithConcurrency, type CommandResult, type RegressionHarness,
} from "./regress.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((entry) => fsp.rm(entry, { recursive: true, force: true }))); });

interface FakeOptions {
  createError?: Error;
  exec?: (argv: string[]) => Promise<CommandResult>;
  guest?: (command: string) => Promise<CommandResult>;
  waitIdle?: () => Promise<string>;
  screen?: () => Promise<string>;
  deleteResult?: { ok: boolean; detail?: string };
  residue?: string[];
  destroyError?: Error;
}

function fakeHarness(options: FakeOptions = {}, calls: string[] = []): RegressionHarness {
  let now = 0;
  return {
    async createMachine(_runId, machine) { calls.push(`create:${machine.name}`); if (options.createError) throw options.createError; },
    async execRbox(_runId, _machine, argv) { calls.push(`exec:${argv.join(" ")}`); return options.exec?.(argv) ?? { stdout: "ok\n", stderr: "", exitCode: 0 }; },
    async guest(_runId, _machine, command) { calls.push(`guest:${command}`); return options.guest?.(command) ?? { stdout: "", stderr: "", exitCode: 0 }; },
    async startTui() { calls.push("tui:start"); }, async keys() { calls.push("tui:keys"); }, async pasteBuffer() { calls.push("tui:paste"); },
    async waitIdle() { return options.waitIdle?.() ?? "ready"; }, async screen() { return options.screen?.() ?? "ready"; },
    async stopTui() { calls.push("tui:stop"); },
    async deleteBootstrapAccount() { calls.push("account:delete"); return options.deleteResult ?? { ok: true }; },
    async destroyFlow() { calls.push("destroy"); if (options.destroyError) throw options.destroyError; },
    async auditResidue(runIds) { calls.push(`audit:${runIds.join(",")}`); return options.residue ?? []; },
    async sleep(ms) { now += ms; }, now: () => now,
  };
}

function oneStep(status: FlowDefinition["status"] = "pass", enrolled = false): FlowDefinition {
  return defineFlow({ name: `one-step-${status}`, status, machines: [{ name: "a", enrolled }], steps: [{ on: "a", exec: ["status"] }] });
}


test("parallel scheduler respects the requested bound and preserves result order", async () => {
  let active = 0; let peak = 0; const releases: Array<() => void> = [];
  const work = async (value: number) => {
    active++; peak = Math.max(peak, active);
    if (value < 2) await new Promise<void>((resolve) => releases.push(resolve));
    active--; return value * 2;
  };
  const pending = runWithConcurrency([0, 1, 2, 3], 2, work);
  await Bun.sleep(1); expect(peak).toBe(2); releases.splice(0).forEach((release) => release());
  expect(await pending).toEqual([0, 2, 4, 6]); expect(peak).toBe(2);
});

test("waitFor timeout attaches the final screen", async () => {
  let capture = 0;
  const flow = defineFlow({ name: "timeout-screen", status: "pass", machines: [{ name: "a", enrolled: false }], steps: [
    { on: "a", tui: "setup" }, { on: "a", waitFor: /finished/, timeout: 0.5 },
  ] });
  const result = await runFlow(flow, "timeout-run", fakeHarness({ waitIdle: async () => "loading-0", screen: async () => `loading-${++capture}` }));
  expect(result.outcome).toBe("FAIL"); expect(result.error).toContain("final screen:\nloading-");
});

test("assertNotStdout checks only command stdout and names the forbidden fragment", async () => {
  const flow = defineFlow({
    name: "negative-stdout", status: "pass", machines: [{ name: "a", enrolled: false }],
    steps: [{ on: "a", exec: ["status"], assertNotStdout: [/secret-[0-9]+/] }],
  });
  const stderrOnly = await runFlow(flow, "negative-stderr", fakeHarness({
    exec: async () => ({ stdout: "safe\n", stderr: "secret-123\n", exitCode: 0 }),
  }));
  expect(stderrOnly.outcome).toBe("PASS");
  const matched = await runFlow(flow, "negative-match", fakeHarness({
    exec: async () => ({ stdout: "prefix secret-456 suffix\n", stderr: "", exitCode: 0 }),
  }));
  expect(matched.outcome).toBe("FAIL");
  expect(matched.error).toContain("stdout matched forbidden fragment /secret-[0-9]+/");
  expect(matched.error).not.toContain("prefix");
  expect(matched.error).not.toContain("suffix");

  const guestFlow = defineFlow({
    name: "negative-guest-stdout", status: "pass", machines: [{ name: "a", enrolled: false }],
    steps: [{ on: "a", guest: "inspect", assertNotStdout: [/forbidden guest/] }],
  });
  const guestMatched = await runFlow(guestFlow, "negative-guest", fakeHarness({
    guest: async () => ({ stdout: "forbidden guest\n", stderr: "", exitCode: 0 }),
  }));
  expect(guestMatched.outcome).toBe("FAIL");
  expect(guestMatched.error).toContain("stdout matched forbidden fragment /forbidden guest/");
});

describe("outcome and exit-code truth table", () => {
  test.each([
    ["pass", true, false, "PASS", false], ["pass", false, false, "FAIL", true],
    ["pending-137", false, false, "PENDING-FAIL", false], ["pending-137", true, false, "XPASS", true],
    ["pending-137", false, true, "FAIL", true],
  ] as const)("%s passed=%s infra=%s -> %s", (status, passed, infra, outcome, nonzero) => {
    const actual = classify(status, passed, infra); expect(actual).toBe(outcome);
    expect(actual === "FAIL" || actual === "XPASS").toBe(nonzero);
  });

  test.each([
    [["PASS"], 0], [["PENDING-FAIL"], 0], [["PASS", "PENDING-FAIL"], 0],
    [["FAIL"], 1], [["XPASS"], 1], [["PASS", "XPASS"], 1],
  ] as const)("aggregate %j exits %i", (outcomes, exitCode) => {
    expect(exitCodeForOutcomes([...outcomes])).toBe(exitCode);
  });
});

test("failure still deletes the account once before teardown and audits only its run id", async () => {
  const calls: string[] = [];
  const harness = fakeHarness({ exec: async () => { throw new Error("step broke"); } }, calls);
  const result = await runFlow(oneStep("pass", true), "owned-run", harness);
  expect(result.outcome).toBe("FAIL");
  expect(calls.filter((call) => call === "account:delete")).toHaveLength(1);
  expect(calls.indexOf("account:delete")).toBeLessThan(calls.indexOf("destroy"));
  expect(calls.at(-1)).toBe("audit:owned-run");
});

test("teardown or delta residue failures are gate failures even for pending flows", async () => {
  const failedStep = { exec: async () => ({ stdout: "", stderr: "", exitCode: 1 }) };
  const teardown = await runFlow(oneStep("pending-137"), "teardown-run", fakeHarness({ ...failedStep, destroyError: new Error("cannot destroy") }));
  expect(teardown.outcome).toBe("FAIL"); expect(teardown.error).toContain("flow teardown");
  const residue = await runFlow(oneStep("pass"), "residue-run", fakeHarness({ residue: ["container:ux-residue-run"] }));
  expect(residue.outcome).toBe("FAIL"); expect(residue.residue).toEqual(["container:ux-residue-run"]);
});

test("provisioning failures cannot masquerade as healthy pending failures", async () => {
  const result = await runFlow(oneStep("pending-137"), "no-container", fakeHarness({ createError: new Error("docker unavailable") }));
  expect(result.outcome).toBe("FAIL"); expect(result.error).toContain("docker unavailable");
});

test("account deletion failures are reported without changing a passing outcome", async () => {
  const result = await runFlow(oneStep("pass", true), "leak-run", fakeHarness({ deleteResult: { ok: false, detail: "delete 503" } }));
  expect(result.outcome).toBe("PASS"); expect(result.accountLeak).toBe("delete 503");
});

test("captured values are redacted from artifacts and later error messages", async () => {
  const artifactDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-regress-redact-")); cleanup.push(artifactDir);
  const secret = "rbox-pair_secret-value";
  const flow = defineFlow({ name: "redaction-proof", status: "pass", machines: [{ name: "a", enrolled: false }], steps: [
    { on: "a", exec: ["pair"] },
    { on: "a", captureVar: { name: "TOKEN", pattern: /token=(rbox-pair_[^\s]+)/ } },
    { on: "a", guest: "fail {{TOKEN}}" },
  ] });
  const result = await runFlow(flow, "redact-run", fakeHarness({
    exec: async () => ({ stdout: `token=${secret}\n`, stderr: "", exitCode: 0 }),
    guest: async () => { throw new Error(`server rejected ${secret}`); },
  }), artifactDir);
  const artifact = await fsp.readFile(path.join(artifactDir, "redaction-proof.json"), "utf8");
  expect(result.error).toContain("[REDACTED]"); expect(result.error).not.toContain(secret);
  expect(artifact).toContain("[REDACTED]"); expect(artifact).not.toContain(secret);
});

test("retention removes unlocked and stale-pid old runs but honors live locks", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-regress-retention-")); cleanup.push(root);
  const now = Date.UTC(2026, 6, 16); const old = new Date(now - 31 * 24 * 60 * 60 * 1000);
  for (const [name, lock] of [["unlocked", undefined], ["live", "101\n"], ["stale", "202\n"]] as const) {
    const dir = path.join(root, name); await fsp.mkdir(dir); if (lock) await fsp.writeFile(path.join(dir, "run.lock"), lock); await fsp.utimes(dir, old, old);
  }
  expect((await pruneRunDirs(root, { now, isPidAlive: (pid) => pid === 101 })).sort()).toEqual(["stale", "unlocked"]);
  expect(await fsp.readdir(root)).toEqual(["live"]);
});
