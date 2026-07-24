
import { isInteractive, promptKeypress, promptPassword } from "../prompt.js";
import { copyToClipboard } from "../browser-open.js";
import { assertNoPendingGenesis, enrollViaPairing } from "../e2ee-client.js";
import { buildPairing, randomBytes, toB64url } from "../../engine/e2ee/index.js";
import { loadDevice } from "../e2ee-keystore.js";
import { readStdinTrimmed } from "../read-stdin.js";
import { friendlyHttpError } from "../http-error.js";


import { requireCreds } from "./session.js";
import { createPairAuth } from "../remote/auth-command-wire.js";
import { pairingRedemptionSuccessMessages, type AuthPresentationContext } from "./presentation.js";

export async function pairCreate(): Promise<void> {
  const creds = await requireCreds();
  if (!creds.accountId) throw new Error("this device isn't enrolled for encryption — run `rbox login --bootstrap <secret>`, `rbox connect` (paste a pairing token from an enrolled machine), or `rbox key recover` first.");
  await assertNoPendingGenesis(creds.accountId);
  const loaded = await loadDevice(creds.accountId);
  if (!loaded || !("secrets" in loaded)) throw new Error("no encryption key on this device — pair/recover this machine before creating a pairing token.");

  // Client owns the tokenId (so the grant binds the exact token, C6) + a 32-byte
  // tokenSecret kept local. The grant is verified-active by buildPairing's caller.
  const tokenId = `t${toB64url(randomBytes(16))}`; // url-safe lookup id (no `.`)
  const tokenSecret = randomBytes(32);
  const notAfter = Date.now() + 10 * 60 * 1000;
  const material = await buildPairing(loaded.secrets, { accountEpoch: 0, tokenId, tokenSecret, notAfter });

  const res = await createPairAuth(
    creds.remoteUrl,
    { tokenId, mkWrap: JSON.stringify(material.mkWrap), admissionGrant: JSON.stringify(material.admissionGrant) },
    creds.token
  );
  if (res.status === 429) throw new Error("too many active pairing tokens — redeem or wait for one to expire");
  if (!res.ok) throw await friendlyHttpError(res, "pair");
  const body = await res.json() as unknown;
  const token = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>).token
    : undefined;
  const command = pairingConnectCommand(token, tokenId, tokenSecret);
  await presentPairingConnectCommand(command);
}

export function pairingConnectCommand(serverToken: unknown, tokenId: string, tokenSecret: Uint8Array): string {
  const expected = `rbox-pair_${tokenId}`;
  if (serverToken !== expected) throw new Error("malformed pairing response (token id mismatch)");
  return `rbox connect ${expected}.${toB64url(tokenSecret)}`;
}

interface PairingConnectPresentationDeps {
  isInteractive?: typeof isInteractive;
  waitForKeypress?: () => Promise<string | undefined>;
  copyToClipboard?: typeof copyToClipboard;
  log?: (message: string) => void;
  write?: (message: string) => void;
}

/** Present and optionally copy the complete one-shot command. Kept separate
 * from minting so the exact executable output is directly regression-tested. */
export async function presentPairingConnectCommand(command: string, deps: PairingConnectPresentationDeps = {}): Promise<void> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const write = deps.write ?? ((message: string) => process.stdout.write(message));
  log("\nPairing command (valid ~10 min, single use — carries your encryption key):\n");
  log(`    ${command}\n`);
  log("Run the command above on the new machine to authorize it and enroll encryption.");

  if ((deps.isInteractive ?? isInteractive)()) {
    write("Press [c] to copy the command to your clipboard, any other key to continue... ");
    const key = await (deps.waitForKeypress ?? promptKeypress)();
    write("\n");
    if (key === "c") {
      log((deps.copyToClipboard ?? copyToClipboard)(command)
        ? "Copied command to clipboard."
        : "Couldn't reach the clipboard — copy the command above manually.");
    }
  }
}

export async function redeemPair(
  remoteUrl: string,
  pairToken: string,
  label?: string,
  presentation: AuthPresentationContext = "standalone"
): Promise<void> {
  const { deviceId } = await enrollViaPairing(remoteUrl, pairToken.trim(), Date.now(), label);
  for (const message of pairingRedemptionSuccessMessages(deviceId, presentation)) console.log(message);
}

interface PairingTokenInputDeps {
  isInteractive?: typeof isInteractive;
  promptPassword?: typeof promptPassword;
  readStdin?: typeof readStdinTrimmed;
}

export async function readPairingTokenInteractive(deps: PairingTokenInputDeps = {}): Promise<string> {
  const token = (deps.isInteractive ?? isInteractive)()
    ? await (deps.promptPassword ?? promptPassword)({ message: "Paste pairing token" })
    : await (deps.readStdin ?? readStdinTrimmed)();
  return token.trim();
}
