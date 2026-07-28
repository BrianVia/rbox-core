import os from "node:os";
import { credentialFailureMessage, loadCredentials } from "../credentials.js";
import { fail, style } from "../style.js";
import { autostartWorkspaceStatuses } from "./desired-state.js";
import { disableAutostart, enableAutostart, execFilePromise, isAutostartEnabled, supportedPlatform, tryExec, type AutostartDeps } from "./install.js";

async function printAutostartStatus(deps: AutostartDeps = {}): Promise<void> {
  const platform = supportedPlatform(deps.platform ?? process.platform);
  const enabled = await isAutostartEnabled(deps);
  console.log(`autostart: ${enabled ? style.green("enabled") : style.yellow("disabled")}`);

  const loaded = await (deps.loadCredentials ?? loadCredentials)();
  const creds = loaded.state === "valid" ? loaded.credentials : undefined;
  if (loaded.state !== "valid" && loaded.state !== "absent") {
    console.log(style.yellow(`credential-degraded: ${credentialFailureMessage(loaded)}`));
  }
  const rows = await autostartWorkspaceStatuses(creds?.accountId);
  if (!rows.length) {
    console.log("workspaces: none");
  } else {
    console.log("workspaces:");
    for (const row of rows) {
      const meta = `${row.workspaceId} · ${row.accountId}${row.reason ? ` · ${row.reason}` : ""}`;
      console.log(`  ${row.status.padEnd(8)} ${row.rootPath} ${style.dim(`(${meta})`)}`);
    }
  }

  if (platform === "linux") {
    const exec = deps.exec ?? execFilePromise;
    const user = process.env.USER ?? os.userInfo().username;
    const output = await tryExec(exec, "loginctl", ["show-user", user, "--property=Linger"]);
    if (typeof output === "string" && output.includes("Linger=no")) {
      console.log(style.dim("note: systemd user units need a login session; headless servers may need `loginctl enable-linger $USER`."));
    }
  }
}

export async function autostartCmd(subcommand: string | undefined, deps: AutostartDeps = {}): Promise<void> {
  if (subcommand === "enable") {
    await enableAutostart(deps);
    console.log(`${style.sym.ok} autostart enabled`);
  } else if (subcommand === "disable") {
    await disableAutostart(deps);
    console.log(`${style.sym.ok} autostart disabled; desired state kept`);
  } else if (subcommand === "status") {
    await printAutostartStatus(deps);
  } else {
    fail("usage: rbox autostart <enable | disable | status>");
  }
}
