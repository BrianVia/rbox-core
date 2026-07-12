/**
 * Compile this checkout into a local host-only development binary.
 *
 * Usage:
 *   bun scripts/dev-install.ts [--outfile <path>]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALL, externalFlagsFor, PARCEL_PKG, type ReleaseTarget } from "./release.js";
import { buildCryptoWorkerBundle } from "./build-crypto-worker.js";
import { style } from "../src/cli/style.js";

const ROOT = path.resolve(import.meta.dir, "..");
const DEFAULT_OUTFILE = path.join(os.homedir(), ".local", "bin", "rbox-dev");
export const DEV_VERSION_DEFINE = "__RBOX_DEV_VERSION__";

export function hostTargetFor(platform = process.platform, arch = process.arch): ReleaseTarget {
  const target = `${platform}-${arch}`;
  if ((ALL as readonly string[]).includes(target)) return target as ReleaseTarget;
  throw new Error(`unsupported host target ${target}; supported targets: ${ALL.join(", ")}`);
}

export function devVersion(packageVersion: string, shortSha: string, dirty: boolean): string {
  return `${packageVersion}-dev+${shortSha}${dirty ? ".dirty" : ""}`;
}

export interface DevBuildArgvOptions {
  target: ReleaseTarget;
  version: string;
  outfile: string;
  entry?: string;
}

export function assembleDevBuildArgv(opts: DevBuildArgvOptions): string[] {
  return [
    "bun",
    "build",
    "--compile",
    `--target=bun-${opts.target}`,
    "--define",
    `${DEV_VERSION_DEFINE}=${JSON.stringify(opts.version)}`,
    ...externalFlagsFor(opts.target),
    opts.entry ?? "./src/cli/index.ts",
    "--outfile",
    opts.outfile,
  ];
}

export function pathContainsDir(pathValue: string | undefined, dir: string): boolean {
  const target = path.resolve(dir);
  return (pathValue ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === target);
}

function parseArgs(argv: string[]): { outfile: string } {
  let outfile = DEFAULT_OUTFILE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--outfile") {
      const value = argv[++i];
      if (!value) throw new Error("usage: bun run dev:install -- [--outfile <path>]");
      outfile = value;
    } else if (arg.startsWith("--outfile=")) {
      outfile = arg.slice("--outfile=".length);
      if (!outfile) throw new Error("usage: bun run dev:install -- [--outfile <path>]");
    } else {
      throw new Error(`unknown argument ${arg}; usage: bun run dev:install -- [--outfile <path>]`);
    }
  }
  return { outfile: path.resolve(outfile) };
}

function sh(cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    const stderr = r.stderr.toString().trim();
    throw new Error(`${cmd.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return r.stdout.toString().trim();
}

function packageVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string") throw new Error("package.json version is missing");
  return pkg.version;
}

function currentDevVersion(): string {
  const shortSha = sh(["git", "rev-parse", "--short=7", "HEAD"]);
  const dirty = sh(["git", "status", "--porcelain"]).length > 0;
  return devVersion(packageVersion(), shortSha, dirty);
}

function runBuild(argv: string[], cwd = ROOT): void {
  const r = Bun.spawnSync(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`command failed: ${argv.join(" ")}`);
}

/** Run `fn` with a fresh scratch dir OUTSIDE the workspace, removed afterward on BOTH
 *  success and failure. `bun build --compile` drops its intermediate `.<hash>.bun-build`
 *  in the process CWD and orphans it on failure/interrupt — running the compile here
 *  keeps that temp out of the synced repo (the 2026-07-12 near-miss). */
export function withBuildScratch<T>(fn: (scratchDir: string) => T): T {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-dev-build-"));
  try {
    return fn(scratchDir);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2)): void {
  const { outfile } = parseArgs(argv);
  const target = hostTargetFor();
  const version = currentDevVersion();
  const outDir = path.dirname(outfile);

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[dev-install] build ${target} (embedding ${PARCEL_PKG[target]})`);
  buildCryptoWorkerBundle();
  withBuildScratch((scratchDir) => {
    runBuild(
      assembleDevBuildArgv({ target, version, outfile, entry: path.join(ROOT, "src", "cli", "index.ts") }),
      scratchDir
    );
  });
  fs.chmodSync(outfile, 0o755);

  console.log(`[dev-install] installed ${outfile}`);
  console.log(`[dev-install] version ${version}`);
  if (!pathContainsDir(process.env.PATH, outDir)) {
    console.warn(style.dim(`[dev-install] warning: ${outDir} is not on PATH; invoke ${outfile} directly or add it manually.`));
  }
  console.log("rbox-dev stop && rbox-dev start  # restart your daemon onto this build");
}

if (import.meta.main) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
