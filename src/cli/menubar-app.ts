import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadToTemp } from "./release-download.js";
import type { Manifest } from "./release-verify.js";

interface BunRuntime {
  spawn(
    command: string[],
    options: { stdout: "pipe"; stderr: "ignore" },
  ): { exited: Promise<number>; stdout: ReadableStream<Uint8Array> };
}

export interface MenuBarDeps {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  run?: (cmd: string[]) => Promise<{ code: number; stdout: string }>;
  download?: (url: string, dir: string) => Promise<{ tmp: string; sha256: string }>;
  log?: (line: string) => void;
}

async function runCommand(cmd: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const bun = (globalThis as typeof globalThis & { Bun: BunRuntime }).Bun;
    const proc = bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return { code, stdout };
  } catch {
    return { code: 1, stdout: "" };
  }
}

export async function syncMenuBarApp(
  manifest: Manifest,
  remoteUrl: string,
  deps: MenuBarDeps = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform !== "darwin" || env.RBOX_NO_MENUBAR_APP === "1") return;

  const artifact = manifest.artifacts["RboxBar.zip"];
  if (!artifact) return;
  const log = deps.log ?? console.log;
  const run = deps.run ?? runCommand;
  const download = deps.download ?? downloadToTemp;
  let staging: string | undefined;

  try {
    const expectedPath = `v${manifest.version}/RboxBar-${manifest.version}.zip`;
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new Error("signed RboxBar artifact has an invalid sha256");
    if (artifact.path !== expectedPath) {
      throw new Error(`signed RboxBar artifact path ${artifact.path} does not match ${expectedPath}`);
    }

    const systemDestination = "/Applications/RboxBar.app";
    const destination = fsSync.existsSync(systemDestination)
      ? systemDestination
      : path.join(deps.homeDir ?? os.homedir(), "Applications", "RboxBar.app");
    const existed = fsSync.existsSync(destination);
    if (existed) {
      const current = await run([
        "plutil",
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        path.join(destination, "Contents", "Info.plist"),
      ]);
      if (current.code === 0 && current.stdout.trim() === manifest.version) return;
    }

    const parent = path.dirname(destination);
    await fs.mkdir(parent, { recursive: true });
    staging = await fs.mkdtemp(path.join(parent, ".RboxBar.stage-"));
    const fetched = await download(`${remoteUrl}/bin/${artifact.path}`, staging);
    if (fetched.sha256 !== artifact.sha256) {
      throw new Error("downloaded RboxBar sha256 did not match the signed manifest");
    }

    const extracted = path.join(staging, "RboxBar.app");
    const unzip = await run(["ditto", "-x", "-k", fetched.tmp, staging]);
    if (unzip.code !== 0) throw new Error(`ditto could not extract RboxBar (exit ${unzip.code})`);
    if (!fsSync.existsSync(extracted)) throw new Error("RboxBar archive did not contain RboxBar.app");

    const wasRunning = (await run(["pgrep", "-x", "RboxBar"])).code === 0;
    if (wasRunning) {
      const killed = await run(["pkill", "-x", "RboxBar"]);
      if (killed.code !== 0) throw new Error(`could not stop RboxBar (exit ${killed.code})`);
      let stopped = false;
      for (let attempt = 0; attempt < 25; attempt += 1) {
        if ((await run(["pgrep", "-x", "RboxBar"])).code !== 0) {
          stopped = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
      if (!stopped) throw new Error("RboxBar did not stop within 5 seconds");
    }

    const backup = `${destination}.old`;
    await fs.rm(backup, { recursive: true, force: true });
    let oldMoved = false;
    let newMoved = false;
    try {
      if (fsSync.existsSync(destination)) {
        await fs.rename(destination, backup);
        oldMoved = true;
      }
      await fs.rename(extracted, destination);
      newMoved = true;
      await fs.rm(backup, { recursive: true, force: true });
    } catch (error) {
      if (oldMoved && fsSync.existsSync(backup)) {
        if (newMoved || fsSync.existsSync(destination)) {
          await fs.rm(destination, { recursive: true, force: true });
        }
        await fs.rename(backup, destination);
      }
      throw error;
    }

    await run(["xattr", "-dr", "com.apple.quarantine", destination]);

    const outcome = existed
      ? `rbox Bar updated to ${manifest.version}`
      : `rbox Bar (macOS menu-bar app) installed to ${destination}`;
    // A first install STARTS the app — default-on is only real if the icon actually
    // appears — while an update only restarts what the user already had running.
    if (!existed || wasRunning) {
      const opened = await run(["open", "-a", destination]);
      log(opened.code === 0
        ? `${outcome} and ${existed ? "restarted" : "started"}`
        : `${outcome} — run \`open -a RboxBar\` to start it`);
      return;
    }
    log(outcome);
  } catch (error) {
    log(`rbox Bar not updated: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
