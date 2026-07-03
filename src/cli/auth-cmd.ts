import os from "node:os";
import { clearCredentials, loadCredentials, PROD_WEB, saveCredentials } from "./credentials.js";
import { cancelableSelect, isInteractive, promptConfirm, promptPassword } from "./prompt.js";
import { copyToClipboard, openInBrowser } from "./browser-open.js";
import { RboxApi } from "./remote.js";
import { bootstrapNewAccount, enrollViaPairing, enrollViaRecovery } from "./e2ee-client.js";
import { buildPairing, randomBytes, toB64url } from "../engine/e2ee/index.js";
import { loadDevice, loadRecoveryKey } from "./e2ee-keystore.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Show the recovery phrase once with a forced acknowledgement (no escrow). The
 *  confirm re-asks until it's a deliberate yes — pressing enter (default No) won't
 *  slip past it — preserving the "you must acknowledge" beat without the literal
 *  "yes" typing of the old readline loop. */
async function showRecoveryPhrase(phrase: string): Promise<void> {
  process.stderr.write(`\n⚠️  rbox is END-TO-END ENCRYPTED. This recovery phrase is the ONLY way back in\n    if you lose every signed-in device. There is NO escrow — we cannot recover it.\n\n    ${phrase}\n\n`);
  if (isInteractive()) {
    while (!(await promptConfirm({ message: "Have you saved this recovery phrase somewhere safe?", default: false }))) {
      process.stderr.write(`    Save it first — it's the ONLY way back in if you lose every device.\n`);
    }
  } else {
    process.stderr.write(`(non-interactive: SAVE THE PHRASE ABOVE — it will not be shown again)\n`);
  }
}

async function postJson(url: string, body: unknown, token?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

/** `rbox login [--bootstrap <secret>] [--plan <solo|pro>]` — obtain a per-device token. */
export async function login(remoteUrl: string, bootstrapSecret?: string, bootstrapPlan?: string): Promise<void> {
  const label = os.hostname();
  // Headless pairing: redeem a token from the env (never argv — it's a bearer).
  const envPair = process.env.RBOX_PAIR_TOKEN;
  if (envPair) {
    await redeemPair(remoteUrl, envPair);
    return;
  }
  if (bootstrapSecret) {
    const res = await postJson(`${remoteUrl}/v1/auth/device/bootstrap`, { secret: bootstrapSecret, label, ...(bootstrapPlan !== undefined ? { plan: bootstrapPlan } : {}) });
    if (!res.ok) throw new Error(`bootstrap failed: ${res.status} ${await res.text()}`);
    const { token, deviceId, accountId } = (await res.json()) as { token: string; deviceId: string; accountId: string };
    await saveCredentials({ token, deviceId, remoteUrl, accountId });
    console.log(`logged in (bootstrapped) as device ${deviceId}`);
    // E2EE: a brand-new account has no key material yet — enroll it now (this
    // device becomes the genesis device) and show the recovery phrase once.
    const api = new RboxApi(remoteUrl, token, "", "");
    if (!(await api.getAccountKeys())) {
      const phrase = await bootstrapNewAccount(api, accountId, deviceId, { now: Date.now() });
      await showRecoveryPhrase(phrase);
      console.log(`encryption enrolled — this workspace will be end-to-end encrypted.`);
    } else {
      console.error(`this account is already set up; to use it on THIS machine, run \`rbox pair\` on a signed-in machine and connect the token, or \`rbox recover\`.`);
    }
    return;
  }

  const startRes = await postJson(`${remoteUrl}/v1/auth/device/start`, { label });
  if (!startRes.ok) throw new Error(`login start failed: ${startRes.status}`);
  const start = (await startRes.json()) as { deviceCode: string; userCode: string; interval: number; expiresIn: number };

  // Browser-optional approval (design 47): print a dashboard URL a web session can
  // approve from any browser (laptop/phone, need not be this machine — the SSH case),
  // while keeping the terminal-to-terminal path for those who prefer it. Read RBOX_APP
  // at the call site so a test/override set after import still wins.
  const approveUrl = `${process.env.RBOX_APP ?? PROD_WEB}/cli-login?code=${start.userCode}`;
  console.log(`\nTo authorize this device, visit:\n`);
  console.log(`    ${approveUrl}\n`);
  console.log(`    (or run \`rbox device approve ${start.userCode}\` on an already-signed-in machine)`);
  console.log(`\nWaiting for approval (expires in ${start.expiresIn}s)...`);

  // The open/copy prompt runs CONCURRENTLY with polling — it never gates a single
  // tick. We keep the cancelable prompt so we can close it the instant approval
  // lands (or on timeout), so it never blocks or outlives the flow.
  const prompt = offerApprovalOpen(approveUrl);
  try {
    const deadline = Date.now() + start.expiresIn * 1000;
    while (Date.now() < deadline) {
      await sleep(start.interval * 1000);
      const pollRes = await postJson(`${remoteUrl}/v1/auth/device/poll`, { deviceCode: start.deviceCode });
      const p = (await pollRes.json()) as { status: string; token?: string; deviceId?: string; accountId?: string; interval?: number };
      if (p.status === "approved" && p.token) {
        await saveCredentials({ token: p.token, deviceId: p.deviceId ?? "unknown", remoteUrl, accountId: p.accountId });
        console.log(`device authorized: ${p.deviceId}`);
        console.error(`note: device-code login authorizes this machine but does NOT enroll it for encryption. To read/sync encrypted data, run \`rbox pair\` on a signed-in machine and connect the token, or \`rbox recover\`.`);
        return;
      }
      if (p.status === "expired" || p.status === "not_found") throw new Error("authorization expired — run `rbox login` again");
      // pending → keep polling
    }
    throw new Error("authorization timed out");
  } finally {
    try {
      prompt?.cancel();
    } catch {
      // already resolved / non-interactive → nothing to close
    }
  }
}

/** Best-effort, non-blocking "open the approval page" helper for the browser-login
 *  flow. Auto-opens the URL opportunistically (a headless spawn just no-ops — there's
 *  no reliable headed/headless signal, so we don't gate on one), then, on a TTY,
 *  shows an [open]/[copy]/[wait] choice WITHOUT the caller awaiting it, so polling
 *  proceeds regardless of whether the user ever answers. Returns the cancelable
 *  prompt (or undefined off-TTY) so the caller can close it once approval lands. */
function offerApprovalOpen(url: string): { cancel: () => void } | undefined {
  openInBrowser(url); // opportunistic; silently no-ops on a headless box
  if (!isInteractive()) return undefined;
  return cancelableSelect<"open" | "copy" | "wait">(
    {
      message: "Open the approval page?",
      choices: [
        { name: "Open in browser", value: "open", description: "launch the URL above in your default browser" },
        { name: "Copy URL to clipboard", value: "copy", description: "paste into a browser on another device (e.g. over SSH)" },
        { name: "I'll approve it another way", value: "wait", description: "keep waiting — approve from any browser or another terminal" },
      ],
    },
    (choice) => {
      if (choice === "open") {
        if (!openInBrowser(url)) console.log(`Open this URL to approve:\n    ${url}`);
      } else if (choice === "copy") {
        console.log(copyToClipboard(url) ? "URL copied to clipboard." : `Copy this URL to approve:\n    ${url}`);
      }
    }
  );
}

export async function logout(): Promise<void> {
  await clearCredentials();
  console.log("logged out (credential removed)");
}

async function requireCreds() {
  const creds = await loadCredentials();
  if (!creds) throw new Error("not logged in — run `rbox login` (or `rbox login --bootstrap <secret>`)");
  return creds;
}

/** `rbox device approve <userCode>` — approve another device's pending login. */
export async function approveDevice(userCode: string): Promise<void> {
  const creds = await requireCreds();
  const res = await postJson(`${creds.remoteUrl}/v1/auth/device/approve`, { userCode }, creds.token);
  if (!res.ok) throw new Error(`approve failed: ${res.status} ${await res.text()}`);
  console.log(`approved ${userCode}`);
}

export async function listDevices(): Promise<void> {
  const creds = await requireCreds();
  const res = await fetch(`${creds.remoteUrl}/v1/auth/devices`, { headers: { authorization: `Bearer ${creds.token}` } });
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  const { devices } = (await res.json()) as { devices: Array<{ device_id: string; label: string | null; created_at: number; last_seen_at: number | null; isSelf: boolean }> };
  for (const d of devices) {
    const seen = d.last_seen_at ? new Date(d.last_seen_at).toISOString() : "never";
    console.log(`${d.isSelf ? "* " : "  "}${d.device_id}  ${d.label ?? ""}  last-seen ${seen}`);
  }
}

/** `rbox pair` — generate a single-use, split-secret token that ALSO carries this
 *  account's MK (wrapped) + a signed admission grant, so the new machine enrolls
 *  for encryption in one paste. The `tokenSecret` half is generated locally and
 *  NEVER sent to the server (design 12 §14.6). Printed once; treat as a secret. */
export async function pairCreate(): Promise<void> {
  const creds = await requireCreds();
  if (!creds.accountId) throw new Error("this device isn't enrolled for encryption — run `rbox login --bootstrap`, `rbox pair`-connect, or `rbox recover` first.");
  const loaded = await loadDevice(creds.accountId);
  if (!loaded || !("secrets" in loaded)) throw new Error("no encryption key on this device — pair/recover this machine before creating a pairing token.");

  // Client owns the tokenId (so the grant binds the exact token, C6) + a 32-byte
  // tokenSecret kept local. The grant is verified-active by buildPairing's caller.
  const tokenId = `t${toB64url(randomBytes(16))}`; // url-safe lookup id (no `.`)
  const tokenSecret = randomBytes(32);
  const notAfter = Date.now() + 10 * 60 * 1000;
  const material = await buildPairing(loaded.secrets, { accountEpoch: 0, tokenId, tokenSecret, notAfter });

  const res = await postJson(
    `${creds.remoteUrl}/v1/auth/pair/create`,
    { tokenId, mkWrap: JSON.stringify(material.mkWrap), admissionGrant: JSON.stringify(material.admissionGrant) },
    creds.token
  );
  if (res.status === 429) throw new Error("too many active pairing tokens — redeem or wait for one to expire");
  if (!res.ok) throw new Error(`pair failed: ${res.status} ${await res.text()}`);
  const { token } = (await res.json()) as { token: string };
  const full = `${token}.${toB64url(tokenSecret)}`; // <redeemToken>.<tokenSecret>
  console.log(`\nPairing token (valid ~10 min, single use — carries your encryption key):\n`);
  console.log(`    ${full}\n`);
  console.log(`On the new machine: run \`rbox\`, choose "Connect this machine", and paste it.`);
}

/** Redeem a split-secret pairing token → device credential + E2EE enrollment.
 *  The full token is read from a prompt/stdin (never argv) and never logged. */
export async function redeemPair(remoteUrl: string, pairToken: string): Promise<void> {
  const { deviceId } = await enrollViaPairing(remoteUrl, pairToken.trim(), Date.now());
  console.log(`device authorized + encryption enrolled: ${deviceId}`);
}

/** `rbox recover` — re-enroll this machine from the recovery phrase (needs an
 *  account login first; the phrase unlocks MK, not server auth — §14.7/D10). */
export async function recoverCmd(): Promise<void> {
  let phrase: string;
  if (isInteractive()) {
    // No-echo — the phrase is key material (mask:false = matches the old no-echo).
    phrase = (await promptPassword({ message: "Enter your 24-word recovery phrase" })).trim();
  } else {
    // Piped (`echo "<phrase>" | rbox recover`) — drain stdin like `connect` does so
    // recovery still works in CI / non-TTY, where inquirer can't run.
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    phrase = Buffer.concat(chunks).toString("utf8").trim();
  }
  if (!phrase) throw new Error("no phrase entered");
  const { deviceId } = await enrollViaRecovery(phrase, Date.now());
  console.log(`recovered + enrolled this device: ${deviceId}`);
}

/** `rbox key status` — local E2EE enrollment state for the current account. */
export async function keyStatus(): Promise<void> {
  const creds = await loadCredentials();
  if (!creds) throw new Error("not logged in — run `rbox login`");
  console.log(`device:   ${creds.deviceId}`);
  console.log(`account:  ${creds.accountId ?? "(unknown — re-login)"}`);
  if (!creds.accountId) return;
  const loaded = await loadDevice(creds.accountId);
  const enrolled = loaded && "secrets" in loaded;
  console.log(`encryption: ${enrolled ? "enrolled (MK present)" : loaded ? "device key present, MK missing — will self-heal on next sync" : "NOT enrolled — run `rbox pair` or `rbox recover`"}`);
  console.log(`recovery phrase cached locally: ${(await loadRecoveryKey(creds.accountId)) ? "yes (`rbox key backup` can re-show)" : "no (use the phrase you saved at setup)"}`);
}

/** `rbox key backup` — re-show the recovery phrase IF it was cached at setup (C9). */
export async function keyBackup(): Promise<void> {
  const creds = await loadCredentials();
  if (!creds?.accountId) throw new Error("not logged in — run `rbox login`");
  const rk = await loadRecoveryKey(creds.accountId);
  if (!rk) {
    console.error("the recovery phrase isn't cached on this device. Use the phrase you saved at setup, or read it from another enrolled device.");
    process.exitCode = 1;
    return;
  }
  const { rkToPhrase } = await import("../engine/e2ee/index.js");
  await showRecoveryPhrase(await rkToPhrase(rk));
}

export async function revokeDevice(deviceId: string): Promise<void> {
  const creds = await requireCreds();
  const res = await postJson(`${creds.remoteUrl}/v1/auth/devices/${deviceId}/revoke`, {}, creds.token);
  if (!res.ok) throw new Error(`revoke failed: ${res.status}`);
  console.log(`revoked ${deviceId}`);
}
