import { credentialFailureMessage, loadCredentials } from "../credentials.js";
import { startDaemon } from "../daemon-control.js";
import { desiredRunningRows } from "./desired-state.js";
import { resumeDesiredDaemon } from "./daemon-state.js";
import type { CommonDeps } from "./desired-state.js";

interface BootResumeDeps extends CommonDeps {
  startDaemon?: typeof startDaemon;
  log?: (line: string) => void;
}

export async function bootResume(deps: BootResumeDeps = {}): Promise<void> {
  const loaded = await (deps.loadCredentials ?? loadCredentials)();
  const log = deps.log ?? ((line: string) => console.log(line));
  if (loaded.state === "absent") {
    log("autostart: not logged in");
    return;
  }
  if (loaded.state !== "valid") {
    log(`autostart: credential-degraded: ${credentialFailureMessage(loaded)}`);
    return;
  }
  const creds = loaded.credentials;
  if (!creds.accountId) {
    log("autostart: credential has no account id");
    return;
  }
  const starter = deps.startDaemon ?? startDaemon;
  for (const row of await desiredRunningRows(creds.accountId)) {
    await resumeDesiredDaemon(row, {
      startDaemon: starter,
    });
  }
}
