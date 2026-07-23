/**
 * `web-pairing` (design 189 / 192) — the headless twin of the two-machine
 * web-approved pairing ceremony, so the auto-key-delivery flow is validated by a
 * single command with no human and no browser.
 *
 *   1. Machine A: fresh dev account via `login --bootstrap` (genesis enrolls
 *      encryption), pro plan, `init --new`, write + push a secret file, `rbox start`
 *      (an online admin daemon; read-write daemons are key-release default-on).
 *   2. Machine B: `rbox login` (device-code) run DETACHED. Non-interactive, so it
 *      just prints the approval URL (`?code=…#fp=…`) and polls. The rig parses the
 *      userCode + fragment fingerprint from that URL — the exact surface a human copies.
 *   3. Approve WITH key consent through the DEV-ONLY scriptable hook
 *      (`POST /v1/auth/device/approve-dev`, design 192) using A's bearer + the dev
 *      bootstrap secret. The response carries the QUEUED key-delivery.
 *   4. B's login self-completes 189: `device authorized + encryption enrolled` (NOT
 *      the legacy device-auth line, NOT the pairing/phrase fallback). B then joins the
 *      workspace and pulls; A's file is byte-identical on B — proving the DELIVERED
 *      master key actually decrypts A's ciphertext. Observable: pending → delivered.
 *   5. Negative: a fresh device-code approved via the REAL `device/approve` with only
 *      `{ userCode }` (no consent) returns bare `{ ok: true }` with no `keyDelivery` —
 *      device auth only, never a key delivery.
 */
import { GUEST } from "../lib/config.js";
import { approveDeviceDev, approveDeviceNoConsent, grantProPlan, readCredentials } from "../lib/account.js";
import { createRecorder, errMsg } from "./harness.js";
import { rigLoginShell, teardownAccount } from "./preamble.js";
import { waitForPath } from "../lib/waiters.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";

/** How long to wait for `rbox login` to print its approval URL. */
const APPROVAL_URL_TIMEOUT_MS = 30_000;
/** How long to wait, after approval, for the daemon to fulfill + B to enroll via 189. */
const ENROLL_TIMEOUT_MS = 150_000;
/** How long to wait for A's file to land on B after B pulls. */
const CONVERGE_TIMEOUT_MS = 60_000;

const SECRET_FILE = "web-pairing-secret.txt";
const SECRET_BODY = "delivered-master-key-decrypts-this-189";

/** The device-code approval URL `rbox login` prints: `…?code=ABCD-EFGH#fp=<43>`.
 *  Pull the userCode + fragment fingerprint the approver needs. PURE. */
const APPROVAL_RE = /[?&]code=([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})#fp=([A-Za-z0-9_-]{43})/;
export function parseDeviceApproval(logText: string): { userCode: string; fingerprint: string } | undefined {
  const m = logText.match(APPROVAL_RE);
  return m ? { userCode: m[1]!, fingerprint: m[2]! } : undefined;
}

/** True once `rbox login`'s detached log shows a captured device-code approval URL. */
function hasApprovalUrl(contents: string | undefined): boolean {
  return contents !== undefined && APPROVAL_RE.test(contents);
}

/** True once B's login reports 189 encryption enrollment (NOT the legacy device-auth
 *  line, NOT a pairing/phrase fallback). */
function isEnrolled(contents: string | undefined): boolean {
  return contents !== undefined && /encryption enrolled/.test(contents);
}

export const webPairing: Scenario = {
  name: "web-pairing",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);
    const posLog = "/tmp/login-pos.log";
    const negLog = "/tmp/login-neg.log";
    let negPid: number | undefined;

    try {
      // 1. A: bootstrap login (secret via env expansion) → genesis enrolls encryption.
      await rec.step("[A] login --bootstrap (+ genesis)", async () => {
        await ctx.a.rboxShell(rigLoginShell("a", ctx.scenarioName, true), {
          env: { RIG_BOOT: ctx.bootstrapSecret },
          redact: [ctx.bootstrapSecret],
        });
      });

      const aCreds = readCredentials(await ctx.a.readFile(`${GUEST.rboxHome}/credentials.json`));
      if (!aCreds.accountId) throw new Error("A credentials.json missing accountId after bootstrap");

      await rec.step("[A] grant pro plan", async () => {
        const grant = await grantProPlan(ctx.apiUrl, aCreds.accountId!, ctx.platformSecret);
        if (!grant.ok) throw new Error(`account plan grant ${grant.status}: ${grant.body.slice(0, 200)}`);
      });

      // 2. A: create the workspace, write + push the secret file.
      const workspaceId = await rec.step("[A] init --new + write + push", async () => {
        await ctx.a.mkdirp(GUEST.workDir);
        await ctx.a.rbox(["init", "--new", "--no-interactive", "--remote", ctx.apiUrl], { cwd: GUEST.workDir });
        const cfg = JSON.parse(await ctx.a.readFile(`${GUEST.workDir}/.rbox/workspace.json`)) as { remoteWorkspaceId?: string };
        if (!cfg.remoteWorkspaceId) throw new Error("workspace.json missing remoteWorkspaceId");
        await ctx.a.writeFile(`${GUEST.workDir}/${SECRET_FILE}`, SECRET_BODY);
        await ctx.a.rbox(["push"], { cwd: GUEST.workDir });
        ctx.log(`  workspace ${cfg.remoteWorkspaceId}`);
        return cfg.remoteWorkspaceId;
      });

      // 3. A: daemon online (the live admin that fulfills the delivery). Wait for its
      //    first heartbeat so it's genuinely connected before B's approval nudges it.
      await rec.step("[A] rbox start (fulfilling daemon)", async () => {
        await ctx.a.daemonStart(GUEST.workDir);
        const beat = await waitForPath(ctx.a, `${GUEST.workDir}/.rbox/state/activity.json`,
          (c) => { try { return typeof (JSON.parse(c ?? "") as { at?: unknown }).at === "string"; } catch { return false; } },
          30_000);
        if (!beat.ok) throw new Error("A daemon never wrote an activity heartbeat");
      });

      // 4. B: device-code login, detached. It prints the approval URL, then polls.
      await rec.step("[B] rbox login (device-code, detached)", async () => {
        await ctx.b.spawnRboxDetached(["login", "--label", "rig-b-web-pairing", "--remote", ctx.apiUrl], posLog);
      });

      const approval = await rec.step("[B] capture approval URL (code + fingerprint)", async () => {
        const out = await waitForPath(ctx.b, posLog, hasApprovalUrl, APPROVAL_URL_TIMEOUT_MS);
        if (!out.ok) throw new Error(`no approval URL within ${APPROVAL_URL_TIMEOUT_MS}ms`);
        const parsed = parseDeviceApproval(out.value ?? "");
        if (!parsed) throw new Error("approval URL present but code/fingerprint did not parse");
        ctx.log(`  userCode ${parsed.userCode}`);
        return parsed;
      });

      // 5. Approve WITH key consent via the dev-only scriptable hook → queues delivery.
      await rec.step("[approve-dev] key-consent approve (queues delivery)", async () => {
        const res = await approveDeviceDev(ctx.apiUrl, aCreds.token, {
          userCode: approval.userCode,
          pubkeyFingerprint: approval.fingerprint,
          bootstrapSecret: ctx.bootstrapSecret,
        });
        rec.assert("approve-dev 200", res.ok, `${res.status}`);
        if (!res.ok) throw new Error(`approve-dev ${res.status}: ${res.body.slice(0, 200)}`);
        rec.assert("key delivery QUEUED (status pending)", res.keyDelivery?.status === "pending",
          res.keyDelivery ? `status=${res.keyDelivery.status}` : "no keyDelivery in response");
        if (res.keyDelivery?.status !== "pending") throw new Error("approve-dev did not queue a delivery");
      });

      // 6. B self-completes 189: daemon wraps MK + publishes admin roster; B verifies the
      //    chain, unwraps, ACKs → delivered. Assert the 189 path (NOT legacy/fallback).
      await rec.step("[B] enroll via 189 auto key delivery", async () => {
        const out = await waitForPath(ctx.b, posLog, isEnrolled, ENROLL_TIMEOUT_MS);
        rec.assert("B enrolled via 189 (encryption enrolled)", out.ok,
          out.ok ? `${out.elapsedMs}ms` : `timeout after ${out.elapsedMs}ms — tail: ${(out.value ?? "").split("\n").slice(-4).join(" | ").slice(0, 300)}`);
        if (!out.ok) throw new Error("B never enrolled via 189 key delivery");
        rec.assert("B did NOT fall back to pairing/phrase",
          !/paste a pairing token|recovery phrase|words/i.test(out.value ?? ""),
          "no pairing/phrase fallback markers in B's login log");
      });

      const bCreds = readCredentials(await ctx.b.readFile(`${GUEST.rboxHome}/credentials.json`));
      rec.assert("B enrolled onto A's account", bCreds.accountId === aCreds.accountId,
        `A=${aCreds.accountId} B=${bCreds.accountId}`);

      // 7. B joins the workspace + pulls; the delivered MK must decrypt A's file.
      await rec.step("[B] init --workspace + pull", async () => {
        await ctx.b.mkdirp(GUEST.workDir);
        await ctx.b.rbox(["init", "--workspace", workspaceId, "--no-interactive", "--remote", ctx.apiUrl], { cwd: GUEST.workDir });
        await ctx.b.rbox(["pull"], { cwd: GUEST.workDir });
      });

      await rec.step("[A→B] delivered key decrypts A's file (byte-identical)", async () => {
        const out = await waitForPath(ctx.b, `${GUEST.workDir}/${SECRET_FILE}`, (c) => c === SECRET_BODY, CONVERGE_TIMEOUT_MS);
        rec.assert("A's file is byte-identical on B", out.ok,
          out.ok ? `${out.elapsedMs}ms` : `got ${JSON.stringify(out.value)?.slice(0, 60)}`);
        if (!out.ok) throw new Error("delivered MK did not decrypt A's file on B");
      });

      // 8. Negative: approve a FRESH device-code WITHOUT consent → device auth only.
      await rec.step("[B] rbox login #2 (negative, detached)", async () => {
        negPid = await ctx.b.spawnRboxDetached(["login", "--label", "rig-b-negative", "--remote", ctx.apiUrl], negLog);
      });
      const negApproval = await rec.step("[B] capture negative approval URL", async () => {
        const out = await waitForPath(ctx.b, negLog, hasApprovalUrl, APPROVAL_URL_TIMEOUT_MS);
        if (!out.ok) throw new Error(`no negative approval URL within ${APPROVAL_URL_TIMEOUT_MS}ms`);
        const parsed = parseDeviceApproval(out.value ?? "");
        if (!parsed) throw new Error("negative approval URL present but did not parse");
        return parsed;
      });
      await rec.step("[approve] no-consent → device auth only, NO delivery", async () => {
        const res = await approveDeviceNoConsent(ctx.apiUrl, aCreds.token, negApproval.userCode);
        rec.assert("no-consent approve 200 {ok:true}", res.ok, `${res.status}: ${res.body.slice(0, 120)}`);
        rec.assert("response carries NO keyDelivery (device auth only)", res.ok && !res.hasKeyDelivery,
          res.hasKeyDelivery ? "unexpected keyDelivery field present" : "bare {ok:true}");
      });
    } catch (e) {
      ctx.log(`✗ scenario aborted: ${errMsg(e)}`);
    } finally {
      if (negPid !== undefined) await ctx.b.killPid(negPid).catch(() => {});
      await ctx.a.daemonStop(GUEST.workDir).catch(() => {});
      await teardownAccount(ctx, rec).catch((e) => ctx.log(`teardown error: ${errMsg(e)}`));
    }

    return finalizeReport({ scenario: webPairing.name, startedAt, finishedAt: new Date().toISOString(), steps: rec.steps, assertions: rec.assertions });
  },
};
