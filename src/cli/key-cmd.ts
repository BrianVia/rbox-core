import { createPatToken, patDisplayPrefix, PAT_MAX_TTL_MS } from "../engine/pat-token.js";
import { sha256Hex, toB64url, utf8 } from "../engine/e2ee/index.js";
import { credentialsForStrictFlow, loadCredentials } from "./credentials.js";
import { admitAgentDevice, assertNoPendingGenesis, newAgentId } from "./e2ee-client.js";
import { loadDevice } from "./e2ee-keystore.js";
import { RboxApi } from "./remote.js";
import { emitJson } from "./json.js";
import { confirmDestructive } from "./prompt.js";
import { shQuote } from "./shell-quote.js";
import { encodeAgentKeyBundle, materializeAgentKey, type AgentKeyBundle } from "./agent-key-bundle.js";
import { readKeyBundle } from "./setup-keyed.js";

function parseDuration(raw: string | undefined): number {
  if (!raw || raw === "true") throw new Error("usage: rbox key create-ci --expires <duration> (suggested: 90d)");
  const m = /^(\d+)(m|h|d|w|y)$/.exec(raw.trim());
  if (!m) throw new Error("invalid --expires duration; use m, h, d, w, or y (for example 90d)");
  const n = Number(m[1]);
  const unit = m[2]!;
  const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : unit === "w" ? 7 * 86_400_000 : PAT_MAX_TTL_MS;
  const ms = n * mult;
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error("invalid --expires duration");
  if (ms > PAT_MAX_TTL_MS) throw new Error("--expires must be no more than 1y");
  return ms;
}

export async function materializeCmd(flags: Record<string, string>): Promise<void> {
  if (flags.key && flags.key !== "true" && flags.key !== "-") {
    throw new Error("refusing --key=<value>: argv leaks secrets via shell history and process listings. Use RBOX_KEY, --key-file <path>, or --key -.");
  }
  if (!process.env.RBOX_KEY && !flags["key-file"] && flags.key !== "-") {
    throw new Error("no key provided — set RBOX_KEY, pass --key-file <path>, or pipe the bundle with --key - (bundles come from `rbox key create-ci`)");
  }
  const out = await materializeAgentKey(await readKeyBundle(flags), { dir: flags.dir && flags.dir !== "true" ? flags.dir : undefined });
  console.log(`export RBOX_HOME=${shQuote(out.home)}`);
  console.log(`export RBOX_TOKEN=${shQuote(out.token)}`);
  console.log(`export RBOX_ACCOUNT_ID=${shQuote(out.accountId)}`);
  console.log(`export RBOX_DEVICE_ID=${shQuote(out.deviceId)}`);
}

async function confirmRootKey(accepted: boolean): Promise<void> {
  const warning =
    "Agent keys are account-root equivalent: the RBOX_KEY bundle carries the Master Key and can decrypt account data. " +
    "Share one key only for pull-only fleets; every writer needs its own key.";
  process.stderr.write(`${warning}\n`);
  const ok = await confirmDestructive({
    message: "Create this account-root agent key?",
    yes: accepted,
    default: false,
    headless: "throw",
    headlessError: "refusing to create an account-root key without --accept-root-key in non-interactive mode",
  });
  if (!ok) throw new Error("cancelled");
}

export async function createCiKey(flags: Record<string, string>): Promise<void> {
  await confirmRootKey(flags["accept-root-key"] === "true");
  const expiresAt = Date.now() + parseDuration(flags.expires);
  const creds = credentialsForStrictFlow(await loadCredentials());
  if (!creds?.accountId) throw new Error("not logged in or missing account id — run `rbox login` first");
  await assertNoPendingGenesis(creds.accountId);
  const loaded = await loadDevice(creds.accountId);
  if (!loaded || !("secrets" in loaded)) throw new Error("this device is not enrolled for encryption — run `rbox pair`/`rbox key recover` first");

  const bearer = createPatToken();
  const deviceId = newAgentId();
  const api = new RboxApi(creds.remoteUrl, creds.token, "", "");
  await api.createApiKey({
    tokenHash: await sha256Hex(utf8(bearer)),
    deviceId,
    expiresAt,
    label: flags.label && flags.label !== "true" ? flags.label : "agent",
    displayPrefix: patDisplayPrefix(bearer),
    enrolled: true,
  });
  const admitted = await admitAgentDevice({
    remoteUrl: creds.remoteUrl,
    bearer,
    accountId: creds.accountId,
    deviceId,
    issuer: loaded.secrets,
    expiresAt,
    now: Date.now(),
  }).catch(async (e) => {
    await api.revokeApiKey(deviceId).catch(() => {
      process.stderr.write(`cleanup failed — the half-created key still counts against the cap; run \`rbox key revoke ${deviceId}\`\n`);
    });
    throw e;
  });
  const bundle: AgentKeyBundle = {
    v: 1,
    kind: "agent",
    bearer,
    accountId: creds.accountId,
    deviceId,
    remoteUrl: creds.remoteUrl,
    device: {
      sigPubKey: toB64url(admitted.sigPubKey),
      sigPrivPkcs8: toB64url(admitted.sigPrivPkcs8),
      encPubSpki: toB64url(admitted.encPubSpki),
      encPrivPkcs8: toB64url(admitted.encPrivPkcs8),
    },
    mk: toB64url(admitted.mk),
    // producer: warm bundles (design 20 §5.2 fast-follow)
    keks: [],
  };
  console.log(`RBOX_KEY=${encodeAgentKeyBundle(bundle)}`);
}

export async function listKeys(opts: { json?: boolean } = {}): Promise<void> {
  const creds = credentialsForStrictFlow(await loadCredentials());
  if (!creds) throw new Error("not logged in — run `rbox login`");
  const keys = await new RboxApi(creds.remoteUrl, creds.token, "", "").listApiKeys();
  if (opts.json) {
    emitJson({ keys });
    return;
  }
  for (const k of keys) {
    const seen = k.lastSeenAt ? new Date(k.lastSeenAt).toISOString() : "never";
    console.log(`${k.deviceId}  ${k.displayPrefix}  expires ${new Date(k.expiresAt).toISOString()}  last-seen ${seen}${k.revoked ? "  revoked" : ""}`);
  }
}

export async function revokeKey(deviceId: string): Promise<void> {
  if (!deviceId) throw new Error("usage: rbox key revoke <id>");
  const creds = credentialsForStrictFlow(await loadCredentials());
  if (!creds) throw new Error("not logged in — run `rbox login`");
  await new RboxApi(creds.remoteUrl, creds.token, "", "").revokeApiKey(deviceId);
  console.log(`revoked ${deviceId}`);
}
