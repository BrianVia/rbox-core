import { credentialFailureMessage, loadCredentials } from "../credentials.js";
import { startDaemon } from "../daemon-control.js";
import { autostartWorkspaceStatuses } from "./desired-state.js";
import { resumeDesiredDaemon } from "./daemon-state.js";
import type { CommonDeps } from "./desired-state.js";
import { ensureFolderAuthority } from "../folder-authority.js";
import { observeFolderAdmission } from "../folder-inventory.js";

interface BootResumeDeps extends CommonDeps {
  startDaemon?: typeof startDaemon;
  log?: (line: string) => void;
  ensureFolderAuthority?: typeof ensureFolderAuthority;
  observeFolderAdmission?: typeof observeFolderAdmission;
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
  const state = await (deps.ensureFolderAuthority ?? ensureFolderAuthority)();
  const observeAdmission = deps.observeFolderAdmission ?? observeFolderAdmission;
  for (const row of await autostartWorkspaceStatuses(creds.accountId)) {
    if (row.status === "stopped") continue;
    const admission = await observeAdmission(row.rootPath, state);
    if (admission.kind !== "admitted") {
      log(`autostart: skipping ${row.rootPath} (${admission.kind}: ${admission.reason})`);
      continue;
    }
    if (row.status !== "running") continue;
    await resumeDesiredDaemon(row, {
      startDaemon: starter,
      trustedFolderAdmission: admission,
    });
  }
}
