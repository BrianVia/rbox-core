
import { clearCredentials, credentialsForStrictFlow, loadCredentials } from "../credentials.js";
import { clearAccountProfile } from "../account-profile.js";
import { isAutostartEnabled } from "../autostart-cmd.js";


export async function logout(): Promise<void> {
  const autostartEnabled = await isAutostartEnabled().catch(() => false);
  await clearCredentials();
  await clearAccountProfile();
  console.log("logged out (credential removed)");
  if (autostartEnabled) console.log("autostart still enabled");
}

export async function requireCreds() {
  const creds = credentialsForStrictFlow(await loadCredentials());
  if (!creds) throw new Error("not logged in — run `rbox login` (or `rbox login --bootstrap <secret>`)");
  return creds;
}
