/**
 * `rbox detect` / `doctor` / `hydrate` — the impure shells over the pure
 * detect/doctor engines (design 08). Reconstruct dependency trees from synced
 * lockfiles instead of syncing node_modules/target/.venv.
 *
 * Security (rule 7 / MF5): we run a FIXED argv keyed by detected lockfile, never
 * a string from synced content; never via a shell; lifecycle/build scripts are
 * disabled by default (see engine/detect.hydrateArgv); and the package-manager
 * binary is resolved from PATH with realpath containment — a repo-shipped
 * `./pnpm` (or a PATH entry inside the workspace) is rejected, so the synced
 * tree can't supply the executable.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectProjects,
  hydrateArgv,
  evaluateReadiness,
  scanManifest,
  type DetectedProject,
  type DetectHints,
  type HostTool,
  type ProjectProbe,
  type VersionRequirement,
} from "../engine/index.js";
import { style, fail } from "./style.js";
import { spinner } from "./spinner.js";

const execFileP = promisify(execFile);

/** The runtimes (beyond the package managers) doctor may probe for versions. */
const RUNTIME_TOOLS = ["node", "go", "rustc", "python", "python3"] as const;

// ── tool resolution (hardened) ─────────────────────────────────────────────

/**
 * Resolve a tool to an absolute path from PATH, rejecting anything that lives
 * inside the workspace (so the synced tree can never provide the binary). Both
 * the PATH entry and the realpath'd target are checked against the workspace
 * root, defeating symlinks that point back in.
 */
async function resolveTool(name: string, workspaceReal: string): Promise<string | null> {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    let entryReal: string;
    try {
      entryReal = await fs.realpath(entry);
    } catch {
      continue;
    }
    if (isInside(entryReal, workspaceReal)) continue; // PATH dir inside the workspace → skip
    const candidate = path.join(entry, name);
    try {
      await fs.access(candidate, fs.constants.X_OK);
    } catch {
      continue;
    }
    const real = await fs.realpath(candidate);
    if (isInside(real, workspaceReal)) continue; // resolves into the workspace → reject
    return real;
  }
  return null;
}

function isInside(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** First of `names` that exists directly in `dir`, or undefined. */
async function firstPresent(dir: string, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    try {
      await fs.access(path.join(dir, name));
      return name;
    } catch {
      /* not present */
    }
  }
  return undefined;
}

/** Probe `tool --version` from a NEUTRAL cwd (never the project) so project-local
 *  version-manager shims (.nvmrc/.tool-versions/.npmrc) can't influence it. */
async function probeVersion(toolPath: string, workspaceReal: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileP(toolPath, ["--version"], { cwd: os.tmpdir(), timeout: 5000 });
    return (stdout || stderr).trim().split("\n")[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// ── packageManager hint extraction (impure) ────────────────────────────────

/** Read `package.json#packageManager` (e.g. "pnpm@8.6.0") → tool name, per dir. */
async function readManagerHints(root: string, projects: DetectedProject[]): Promise<DetectHints> {
  const managerByDir: Record<string, string> = {};
  for (const p of projects) {
    if (p.rule.ecosystem !== "node") continue;
    const pkgPath = path.join(root, p.dir, "package.json");
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as { packageManager?: string };
      const pm = pkg.packageManager?.split("@")[0]?.trim();
      if (pm) managerByDir[p.dir] = pm;
    } catch {
      /* no/invalid package.json — leave unhinted */
    }
  }
  return { managerByDir };
}

/** Extract cheap runtime version requirements from a project's manifest. */
async function readRequirements(root: string, p: DetectedProject): Promise<VersionRequirement[]> {
  const reqs: VersionRequirement[] = [];
  const read = async (rel: string) => fs.readFile(path.join(root, p.dir, rel), "utf8");
  try {
    if (p.rule.ecosystem === "node") {
      const pkg = JSON.parse(await read("package.json")) as { engines?: { node?: string } };
      if (pkg.engines?.node) reqs.push({ tool: "node", constraint: pkg.engines.node });
    } else if (p.rule.ecosystem === "go") {
      const m = (await read("go.mod")).match(/^go\s+(\d+\.\d+)/m);
      if (m) reqs.push({ tool: "go", constraint: m[1]! });
    } else if (p.rule.ecosystem === "rust") {
      const m = (await read("Cargo.toml")).match(/rust-version\s*=\s*"([^"]+)"/);
      if (m) reqs.push({ tool: "rustc", constraint: m[1]! });
    } else if (p.rule.ecosystem === "python") {
      const m = (await read("pyproject.toml")).match(/requires-python\s*=\s*"([^"]+)"/);
      if (m) reqs.push({ tool: "python", constraint: m[1]! });
    }
  } catch {
    /* manifest missing/unreadable — already warned by detect */
  }
  return reqs;
}

// ── shared: detect from the live (ignore-aware) tree ───────────────────────

async function detectFromDisk(root: string, manager?: string): Promise<DetectedProject[]> {
  const manifest = await scanManifest(root); // ignore-aware → no node_modules/target descent
  const files = manifest.files.map((f) => f.path);
  const projects = detectProjects(files); // first pass to know which dirs need hints
  const hints = await readManagerHints(root, projects);
  if (manager) hints.manager = manager;
  return detectProjects(files, hints);
}

// ── commands ────────────────────────────────────────────────────────────────

export async function detectCmd(root: string, manager?: string): Promise<void> {
  const projects = await detectFromDisk(root, manager);
  if (projects.length === 0) {
    console.log(style.dim("no hydratable projects detected (no recognized lockfiles)."));
    return;
  }
  console.log(`${style.bold("detected projects")} ${style.dim(`(${projects.length})`)}:`);
  for (const p of projects) {
    const loc = p.dir || ".";
    const flag = p.ambiguous ? style.red(" [ambiguous]") : p.rule.fetchRunsCode ? style.yellow(" [needs --allow-build]") : "";
    console.log(`  ${style.sym.bullet} ${style.cyan(loc)} ${style.dim("→")} ${p.rule.id}${flag}`);
    for (const w of p.warnings) console.log(`      ${style.yellow("!")} ${style.dim(w)}`);
  }
}

export async function doctorCmd(root: string): Promise<void> {
  const workspaceReal = await fs.realpath(root);
  const projects = await detectFromDisk(root);
  if (projects.length === 0) {
    console.log(style.dim("no hydratable projects detected — nothing to check."));
    return;
  }

  // Probe every needed tool + runtime once (from a neutral cwd).
  const needed = new Set<string>();
  for (const p of projects) needed.add(p.rule.tool);
  for (const t of RUNTIME_TOOLS) needed.add(t);
  const hostTools: HostTool[] = [];
  for (const name of needed) {
    const tp = await resolveTool(name, workspaceReal);
    hostTools.push({ name, present: tp !== null, version: tp ? await probeVersion(tp, workspaceReal) : undefined });
  }
  // python falls back to python3 if the former is absent.
  const py = hostTools.find((t) => t.name === "python");
  const py3 = hostTools.find((t) => t.name === "python3");
  if (py && !py.present && py3?.present) {
    py.present = true;
    py.version = py3.version;
  }

  const probes: ProjectProbe[] = [];
  for (const p of projects) probes.push({ dir: p.dir, ecosystem: p.rule.ecosystem, tool: p.rule.tool, requirements: await readRequirements(root, p) });

  const report = evaluateReadiness(probes, hostTools);
  console.log(`${style.bold("doctor")} — host readiness:`);
  for (const r of report.projects) {
    const sym = r.status === "ready" ? style.sym.ok : r.status === "warn" ? style.sym.warn : style.sym.err;
    console.log(`  ${sym} ${style.cyan(r.dir || ".")} ${style.dim(`(${r.ecosystem})`)} — ${r.detail}`);
    if (r.fix) console.log(`      ${style.dim("fix:")} ${r.fix}`);
  }
  if (!report.ok) {
    process.exitCode = 1;
    console.log(style.yellow("\nsome projects are not ready — see fixes above."));
  } else {
    console.log(style.green("\nall detected projects are ready to hydrate."));
  }
}

export async function hydrateCmd(root: string, opts: { allowBuild: boolean; manager?: string; only?: string }): Promise<void> {
  const workspaceReal = await fs.realpath(root);
  let projects = await detectFromDisk(root, opts.manager);
  if (opts.only) projects = projects.filter((p) => p.rule.ecosystem === opts.only || p.rule.id === opts.only);
  if (projects.length === 0) {
    console.log(style.dim("no hydratable projects detected."));
    return;
  }

  let failures = 0;
  let skipped = 0;
  for (const p of projects) {
    const loc = p.dir || ".";
    if (p.ambiguous) {
      // A hard, user-resolvable blocker (not an intentional skip) → counts as failure.
      failures++;
      fail(`${loc}: ${p.warnings.find((w) => w.startsWith("ambiguous")) ?? "ambiguous package manager"}`);
      continue;
    }
    const argv = hydrateArgv(p.rule, opts.allowBuild);
    if (argv === null) {
      skipped++;
      console.log(`${style.sym.warn} ${style.cyan(loc)} ${style.dim(`(${p.rule.id})`)} skipped — runs project build code; re-run with ${style.bold("--allow-build")} to permit it.`);
      continue;
    }
    // Containment: realpath the cwd immediately before spawn and assert it's
    // inside the workspace (a symlinked project dir could otherwise escape).
    let cwdReal: string;
    try {
      cwdReal = await fs.realpath(path.join(root, p.dir));
    } catch {
      failures++;
      fail(`${loc}: directory not found.`);
      continue;
    }
    if (!isInside(cwdReal, workspaceReal)) {
      failures++;
      fail(`${loc}: resolves outside the workspace (symlink escape) — refusing to hydrate.`);
      continue;
    }
    // Untrusted project manager-config (yarn `.yarnrc.yml` → yarnPath/plugins =
    // repo code at startup) gates auto-run behind explicit --allow-build.
    if (!opts.allowBuild && p.rule.untrustedConfigFiles.length > 0) {
      const found = await firstPresent(cwdReal, p.rule.untrustedConfigFiles);
      if (found) {
        skipped++;
        console.log(`${style.sym.warn} ${style.cyan(loc)} skipped — ${style.bold(found)} can run project code (yarnPath/plugins); re-run with ${style.bold("--allow-build")} to permit it.`);
        continue;
      }
    }
    const toolPath = await resolveTool(p.rule.tool, workspaceReal);
    if (!toolPath) {
      failures++;
      fail(`${loc}: ${p.rule.tool} not found on PATH (outside the workspace) — install it or run \`rbox doctor\`.`);
      continue;
    }
    // Defense in depth: make yarn ignore any repo-local yarnPath even if reached.
    const env = p.rule.tool === "yarn" ? { ...process.env, YARN_IGNORE_PATH: "1" } : process.env;
    const ok = await runHydrate(toolPath, argv, cwdReal, `${loc} ${style.dim(`(${p.rule.tool} ${argv.join(" ")})`)}`, env);
    if (!ok) failures++;
  }

  const summary = `${style.bold("hydrate")}: ${style.green(`${projects.length - failures - skipped} ok`)}, ${skipped ? style.yellow(`${skipped} skipped`) : style.dim("0 skipped")}, ${failures ? style.red(`${failures} failed`) : style.dim("0 failed")}`;
  console.log(`\n${summary}`);
  if (failures > 0) process.exitCode = 1;
}

/** Run one hydrate step (no shell; streamed to the user). */
function runHydrate(toolPath: string, argv: string[], cwd: string, label: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const sp = spinner(`hydrating ${label}`);
  return new Promise<boolean>((resolve) => {
    const child = spawn(toolPath, argv, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => {
      sp.fail(`hydrate failed: ${label}`);
      resolve(false);
    });
    child.on("close", (code) => {
      if (code === 0) {
        sp.succeed(`hydrated ${label}`);
        resolve(true);
      } else {
        sp.fail(`${label} exited ${code}`);
        resolve(false);
      }
    });
  });
}
