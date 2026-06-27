import { generateKek, kekFromPhrase, kekToPhrase } from "../engine/index.js";
import { loadConfig, saveConfig } from "./config.js";
import { loadKek, saveKek } from "./keystore.js";

/** `rbox encrypt` — turn on blob-content encryption for this workspace. */
export async function encryptWorkspace(root: string): Promise<void> {
  const cfg = await loadConfig(root);
  if (cfg.encrypted) {
    console.log("workspace already encrypted");
    return;
  }
  if (cfg.syncGit) throw new Error("encryption + git-state sync aren't supported together yet (M5); disable one for now");
  const kek = generateKek();
  await saveKek(cfg.remoteWorkspaceId, kek);
  cfg.encrypted = true;
  await saveConfig(root, cfg);
  console.log("workspace encryption ENABLED (blob content; manifest metadata still visible to the server).");
  console.log("\n  RECOVERY PHRASE — store it somewhere safe. Lose it on every device and the data is UNRECOVERABLE:\n");
  console.log(`    ${kekToPhrase(kek)}\n`);
  console.log("Add it to another device with:  rbox key import <recovery-phrase>");
}

/** `rbox key export` — print the recovery phrase (to enroll another device). */
export async function exportKey(root: string): Promise<void> {
  const cfg = await loadConfig(root);
  const kek = await loadKek(cfg.remoteWorkspaceId);
  if (!kek) throw new Error("no key for this workspace on this device");
  console.log("recovery phrase (treat as a secret):\n");
  console.log(`    ${kekToPhrase(kek)}`);
}

/** `rbox key import <phrase>` — install the workspace key on this device. */
export async function importKey(root: string, phrase: string): Promise<void> {
  const cfg = await loadConfig(root);
  const kek = kekFromPhrase(phrase);
  await saveKek(cfg.remoteWorkspaceId, kek);
  if (!cfg.encrypted) {
    cfg.encrypted = true;
    await saveConfig(root, cfg);
  }
  console.log("workspace key imported; encryption enabled on this device");
}
