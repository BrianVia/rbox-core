import { describe, expect, test } from "bun:test";
import {
  approveDeviceCode, assertBurnCleanup, assertNoResidue, extractPairingToken,
  extractUserCode, main, parseScenarioArgs, renderPlan, setupMachineA,
  setupMachineB, waitForScreen,
} from "./dev-backed-scenario.js";
import { DEV_API } from "./mint-account.js";
import type { RegressionHarness } from "../ux/regress.js";

test("argument parser exposes only help and dry-run", () => {
  expect(parseScenarioArgs([])).toEqual({ dryRun: false, help: false });
  expect(parseScenarioArgs(["--dry-run"])).toEqual({ dryRun: true, help: false });
  expect(parseScenarioArgs(["-h"])).toEqual({ dryRun: false, help: true });
  expect(() => parseScenarioArgs(["--api", DEV_API])).toThrow(/unknown option/);
});

test("dry-run prints a secret-free plan and performs no injected I/O", async () => {
  const writes: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((value: string) => { writes.push(value); return true; }) as typeof process.stdout.write;
  try { await main(["--dry-run"], { RBOX_API: DEV_API }); }
  finally { process.stdout.write = original; }
  const output = writes.join("");
  expect(output).toBe(`${renderPlan()}\n`);
  expect(output).not.toMatch(/sk_(?:test|live)|Bearer|rbox-pair_/);
});

test("dry-run shares U1's exact DEV refusal guard", async () => {
  for (const target of [undefined, "https://api.rbox.to", "http://localhost:8787", `${DEV_API}.evil.test`, `${DEV_API}/v1`]) {
    await expect(main(["--dry-run"], { RBOX_API: target })).rejects.toThrow(/refus|must be set/i);
  }
});

test("approval and pairing values are extracted from real UI shapes", () => {
  expect(extractUserCode("visit https://app.rbox.to/cli-login?code=ABCD-EFGH now")).toBe("ABCD-EFGH");
  expect(() => extractUserCode("https://app.rbox.to/cli-login?code=bad")).toThrow(/user code/);
  const token = `rbox-pair_${"a".repeat(16)}.${Buffer.alloc(32, 7).toString("base64url")}`;
  expect(extractPairingToken(`Pairing token (valid ~10 min, single use):\n${token}\n`)).toBe(token);
});

describe("device approval boundary", () => {
  test("pins the exact DEV URL and keeps the bearer in headers", async () => {
    let input = ""; let init: RequestInit | undefined;
    await approveDeviceCode(DEV_API, "web-secret", "ABCD-EFGH", async (seenInput, seenInit) => {
      input = String(seenInput); init = seenInit; return new Response("{}", { status: 200 });
    });
    expect(input).toBe(`${DEV_API}/v1/auth/device/approve`);
    expect(init?.headers).toEqual({ authorization: "Bearer web-secret", "content-type": "application/json" });
    expect(init?.body).toBe(JSON.stringify({ userCode: "ABCD-EFGH" }));
    expect(input).not.toContain("web-secret");
  });

  test("refuses non-DEV targets, malformed codes, and suppresses response bodies", async () => {
    await expect(approveDeviceCode("https://api.rbox.to", "secret", "ABCD-EFGH")).rejects.toThrow(/refusing non-dev/);
    await expect(approveDeviceCode(DEV_API, "secret", "../../prod")).rejects.toThrow(/malformed/);
    await expect(approveDeviceCode(DEV_API, "secret", "ABCD-EFGH", async () => new Response("sensitive upstream body", { status: 403 })))
      .rejects.toThrow("response body suppressed");
  });
});

test("screen waiter is clock-injected and never includes secret screen contents in errors", async () => {
  let now = 0; let reads = 0;
  const harness = {
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
    screen: async () => ++reads === 3 ? "finished" : "rbox-pair_super-secret.payload",
  };
  expect(await waitForScreen(harness, "run", "a", "session", /finished/, 1)).toBe("finished");
  reads = 0; now = 0;
  await expect(waitForScreen({ ...harness, screen: async () => "rbox-pair_super-secret.payload" }, "run", "a", "session", /never/, 0.25))
    .rejects.not.toThrow(/super-secret/);
});

test("cleanup assertions require account inaccessibility and zero scoped residue", () => {
  expect(() => assertBurnCleanup({ accountId: "acct_0123456789abcdef", status: "pending", verified: "account_inaccessible" }, "acct_0123456789abcdef")).not.toThrow();
  expect(() => assertBurnCleanup({ accountId: "acct_0123456789abcdef", status: "pending", verified: "reachable" }, "acct_0123456789abcdef")).toThrow(/inaccessible/);
  expect(() => assertNoResidue([])).not.toThrow();
  expect(() => assertNoResidue(["container:ux-run"])).toThrow(/residue/);
});

function tuiHarness(screens: string[], events: string[]): RegressionHarness {
  let index = 0;
  const advance = () => { index = Math.min(index + 1, screens.length - 1); };
  return {
    createMachine: async () => {}, execRbox: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    guest: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    startTui: async (_run, machine) => { events.push(`start:${machine}`); },
    keys: async (_run, machine, _session, keys) => { events.push(`keys:${machine}:${keys.join("+")}`); advance(); },
    pasteBuffer: async (_run, machine, _session, value) => { events.push(`paste:${machine}:${value}`); },
    waitIdle: async () => screens[index]!, screen: async () => screens[index]!,
    stopTui: async () => {}, deleteBootstrapAccount: async () => ({ ok: true }),
    destroyFlow: async () => {}, auditResidue: async () => [], sleep: async () => {}, now: () => 0,
  };
}

test("machine A driver pins device approval, immediate genesis, workspace, daemon, and inline-pair ordering", async () => {
  const token = `rbox-pair_${"a".repeat(16)}.${Buffer.alloc(32, 9).toString("base64url")}`;
  const screens = [
    "Are you new here, or do you already have an rbox account?",
    "Press Enter to sign up in your browser",
    "https://app.rbox.to/cli-login?code=ABCD-EFGH",
    "Set up encryption on this first machine now?",
    "Have you saved this recovery phrase somewhere safe?",
    "What do you want to track here?",
    "Which directory should rbox sync?",
    'Workspace name (Enter accepts, "-" for none)',
    "How should rbox handle gitignored files?",
    "Keep this workspace syncing in the background?",
    "Set up another machine now",
    `Pairing token (valid ~10 min, single use):\n\n${token}`,
  ];
  const events: string[] = [];
  const h = tuiHarness(screens, events);
  const paired = await setupMachineA(h, "run-a", "session-a", "web-secret", async (api, secret, code) => {
    events.push(`approve:${api}:${secret}:${code}`);
    // Approval, rather than a keystroke, advances the CLI to its next prompt.
    (h.keys as unknown as (_r: string, _m: string, _s: string, _k: string[]) => Promise<void>)("", "approve", "", []);
  });
  expect(paired).toBe(token);
  expect(events).toEqual([
    "start:a", "keys:a:Enter", "keys:a:Enter",
    `approve:${DEV_API}:web-secret:ABCD-EFGH`, "keys:approve:",
    "keys:a:Enter", "keys:a:y+Enter", "keys:a:Enter", "keys:a:Enter",
    "keys:a:dev-e2e+Enter", "keys:a:Enter", "keys:a:Down+Enter", "keys:a:Enter",
  ]);
});

test("machine B driver pastes the bearer through tmux and joins the existing workspace", async () => {
  const token = `rbox-pair_${"b".repeat(16)}.${Buffer.alloc(32, 5).toString("base64url")}`;
  const screens = [
    "Are you new here, or do you already have an rbox account?",
    "How do you want to authorize this machine?",
    "Paste pairing token",
    "What do you want to track here?",
    "Pick an existing workspace to sync",
    "Which directory should rbox sync?",
    "Keep this workspace syncing in the background?",
    "Set up another machine now",
    "To pair more devices later",
  ];
  const events: string[] = [];
  await setupMachineB(tuiHarness(screens, events), "run-b", "session-b", token);
  expect(events).toEqual([
    "start:b", "keys:b:Down+Enter", "keys:b:Down+Enter", `paste:b:${token}`,
    "keys:b:Enter", "keys:b:Down+Enter", "keys:b:Enter", "keys:b:Enter",
    "keys:b:Down+Enter", "keys:b:Down+Enter",
  ]);
});
