#!/usr/bin/env bun
/**
 * Live-test the CURRENT TREE's CLI as a real user, safely.
 *
 * Builds a dev binary for this host, mints a FRESH throwaway account on the
 * DEV API (bootstrap secret from dev-keys.local.secret), isolates all state
 * under a scratch HOME, and drops you into the interactive first-run — the
 * bootstrap login's encryption genesis (multi-select recovery destinations)
 * followed by `rbox setup` in a seeded demo project. Your real account,
 * ~/.rbox, and the installed binary are never touched.
 *
 * Usage:
 *   bun run demo                 # full first-run: login+genesis, then setup
 *   bun run demo -- status       # run any command in the demo environment
 *   bun run demo --skip-build    # reuse the last built dev binary
 *
 * Each invocation starts from a clean HOME and a new account, so the fresh
 * genesis flow is always reachable. Demo state: ~/.rbox-dev-demo
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEV_API = "https://rbox-dev-api.brian-via.workers.dev";
const repoRoot = path.resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const skipBuild = argv.includes("--skip-build");
const command = argv.filter((arg) => arg !== "--skip-build");

const hostTarget = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const binary = path.join(repoRoot, "dist", `rbox-${hostTarget}`);

function fail(message: string): never {
  console.error(`dev-demo: ${message}`);
  process.exit(1);
}

function secretFromFile(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const line = fs.readFileSync(file, "utf8").split("\n").find((entry) => entry.startsWith("RBOX_DEV_BOOTSTRAP_SECRET="));
  return line?.slice("RBOX_DEV_BOOTSTRAP_SECRET=".length).trim() || undefined;
}

// dev-keys.local.secret is untracked, so a worktree checkout won't have it —
// fall back to the primary checkout via the shared git common dir.
const commonDir = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], { stdout: "pipe" })
  .stdout.toString().trim();
const secret = process.env.RBOX_DEV_BOOTSTRAP_SECRET?.trim()
  || secretFromFile(path.join(repoRoot, "dev-keys.local.secret"))
  || (commonDir ? secretFromFile(path.join(path.dirname(commonDir), "dev-keys.local.secret")) : undefined);
if (!secret) fail("no RBOX_DEV_BOOTSTRAP_SECRET (env, repo root, or primary checkout dev-keys.local.secret)");

if (!skipBuild) {
  console.error(`dev-demo: building ${hostTarget} from the current tree…`);
  const build = Bun.spawnSync(["bun", "scripts/release.ts", "--dev", `--targets=${hostTarget}`], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) fail("dev build failed");
}
if (!fs.existsSync(binary)) fail(`${binary} missing — run without --skip-build`);

const demoHome = path.join(os.homedir(), ".rbox-dev-demo");
fs.rmSync(demoHome, { recursive: true, force: true });
const project = path.join(demoHome, "demo-project");
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, "notes.md"), "# demo\n");
fs.writeFileSync(path.join(project, "hello.txt"), "hello\n");

const env = {
  ...process.env,
  HOME: demoHome,
  RBOX_HOME: demoHome,
  RBOX_API: DEV_API,
  RBOX_API_QUIET: "1",
  RBOX_APP: "",
};

function run(args: string[], cwd: string): number {
  const child = Bun.spawnSync([binary, ...args], { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return child.exitCode ?? 1;
}

console.error(`dev-demo: fresh account on DEV, state in ${demoHome} (delete freely)`);
const login = run(["login", "--bootstrap", secret, "--label", `dev-demo-${Date.now()}`, "--remote", DEV_API], project);
if (login !== 0) fail(`bootstrap login exited ${login}`);
process.exit(run(command.length > 0 ? command : ["setup"], project));
