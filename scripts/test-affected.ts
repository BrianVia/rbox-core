#!/usr/bin/env bun
/**
 * Affected-only test selection for the local verify loop.
 *
 *   bun run test:affected              # run bun + api tests affected by your diff
 *   bun run test:affected --dry-run    # show the selection (with provenance), run nothing
 *   bun run test:affected --base REF   # diff against REF instead of merge-base(HEAD, origin/main)
 *
 * The diff is BASE → working tree (committed + staged + unstaged + untracked),
 * where BASE defaults to the merge-base with origin/main — i.e. "everything I
 * changed on this branch, including what I haven't committed yet".
 *
 * Selection is a reverse walk of the static import graph over src/, scripts/
 * and apps/api/ (relative imports, .js→.ts, index files, `?raw` assets), plus
 * repo-path string literals (e.g. a test that `Bun.spawn`s scripts/foo.ts names
 * it in a string — that edge matters even without an import). A test runs iff a
 * changed file is in its transitive dependency closure.
 *
 * Fallbacks are deliberately conservative:
 *  - toolchain/config changes (package.json, bun.lock, bunfig.toml,
 *    tsconfig.json, the test preload, this script) → FULL bun suite;
 *  - any change reaching apps/api/src/**, wrangler.jsonc, migrations/ or the
 *    vitest config → FULL `vitest run` (api tests exercise the composed worker
 *    over SELF and share one workerd, so per-file selection there is unsound);
 *  - changed files that reach NO test are listed, not silently dropped.
 *
 * This is a dev-loop accelerator. CI still runs the full sharded suites and
 * remains the merge gate — a green `test:affected` is necessary, not sufficient.
 */
import path from "node:path";

const HERE = "scripts/test-affected.ts";
const REPO = process.cwd();

// ── args ─────────────────────────────────────────────────────────────────────
let baseArg: string | undefined;
let dryRun = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]!;
  if (arg === "--dry-run" || arg === "--list") dryRun = true;
  else if (arg === "--base") baseArg = process.argv[++i];
  else if (arg.startsWith("--base=")) baseArg = arg.slice("--base=".length);
  else {
    console.error(`usage: bun ${HERE} [--base REF] [--dry-run]`);
    process.exit(2);
  }
}

// ── changed files ────────────────────────────────────────────────────────────
async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err.trim()}`);
  return out;
}

async function resolveBase(): Promise<string> {
  if (baseArg) return (await git("rev-parse", "--verify", `${baseArg}^{commit}`)).trim();
  for (const ref of ["origin/main", "main"]) {
    try {
      return (await git("merge-base", "HEAD", ref)).trim();
    } catch {
      /* ref absent (shallow clone, detached fixture repo) — try the next */
    }
  }
  throw new Error("cannot resolve a base: neither origin/main nor main exists; pass --base REF");
}

const base = await resolveBase();
const changed = new Set<string>();
for (const line of (await git("diff", "--name-only", base)).split("\n")) if (line) changed.add(line);
for (const line of (await git("ls-files", "--others", "--exclude-standard")).split("\n")) if (line) changed.add(line);

if (changed.size === 0) {
  console.log(`test-affected: no changes vs ${base.slice(0, 10)} — nothing to run`);
  process.exit(0);
}

// ── module graph ─────────────────────────────────────────────────────────────
async function discover(pattern: string): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: REPO, onlyFiles: true })) {
    const norm = file.replaceAll("\\", "/");
    if (!norm.includes("node_modules/")) files.push(norm);
  }
  return files;
}

const moduleFiles = (await Promise.all(["src/**/*.ts", "scripts/**/*.ts", "apps/api/**/*.ts"].map(discover))).flat().sort();
const moduleSet = new Set(moduleFiles);

/** Resolve an import specifier or string-literal path to a repo-relative file, or undefined. */
function resolveRef(fromFile: string, spec: string): string | undefined {
  const clean = spec.split("?")[0]!; // `../../docs/DEPLOYMENTS.md?raw` → the file
  if (!clean.startsWith("./") && !clean.startsWith("../")) return undefined; // bare = external package
  const abs = path.resolve(REPO, path.dirname(fromFile), clean);
  const rel = path.relative(REPO, abs).replaceAll("\\", "/");
  if (rel.startsWith("..")) return undefined;
  const candidates = [rel, `${rel}.ts`, `${rel}.tsx`, rel.replace(/\.js$/, ".ts"), `${rel}/index.ts`];
  for (const c of candidates) if (moduleSet.has(c) || knownFiles.has(c)) return c;
  return undefined;
}

/** Non-TS files referenced by imports/literals (docs, sql, sh) still form edges. */
const knownFiles = new Set<string>();
for (const line of (await git("ls-files")).split("\n")) if (line) knownFiles.add(line);
for (const f of changed) knownFiles.add(f); // untracked files count too

const IMPORT_RE = /\b(?:import|export)\b[^"'`;]*?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']/g;
const LITERAL_RE = /["'`]((?:src|scripts|apps|docs)\/[A-Za-z0-9_\-./]+\.[A-Za-z0-9]+)["'`]/g;

// importers.get(dep) = files that depend on dep
const importers = new Map<string, Set<string>>();
function addEdge(from: string, to: string): void {
  if (to === from) return;
  let set = importers.get(to);
  if (!set) importers.set(to, (set = new Set()));
  set.add(from);
}

await Promise.all(
  moduleFiles.map(async (file) => {
    const source = await Bun.file(path.join(REPO, file)).text();
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (!spec) continue;
      const dep = resolveRef(file, spec);
      if (dep) addEdge(file, dep);
    }
    for (const match of source.matchAll(LITERAL_RE)) {
      const ref = match[1]!;
      const dep = moduleSet.has(ref) || knownFiles.has(ref) ? ref : undefined;
      if (dep) addEdge(file, dep);
    }
  })
);

// Reverse BFS from the changed set; `via` records one concrete dependency path
// step so every selected test can name the changed file that pulled it in.
const affected = new Set<string>(changed);
const via = new Map<string, string>();
const queue = [...changed];
while (queue.length > 0) {
  const dep = queue.shift()!;
  for (const importer of importers.get(dep) ?? []) {
    if (affected.has(importer)) continue;
    affected.add(importer);
    via.set(importer, dep);
    queue.push(importer);
  }
}

function provenance(file: string): string {
  const chain: string[] = [file];
  let cursor = file;
  while (via.has(cursor)) {
    cursor = via.get(cursor)!;
    chain.push(cursor);
  }
  const root = chain[chain.length - 1]!;
  return root === file ? "directly changed" : `← ${chain.length > 2 ? "…" : ""}${root}`;
}

// ── domain selection ─────────────────────────────────────────────────────────
const isTest = (f: string) => f.endsWith(".test.ts");

// Bun domain: what `bun run test` covers (src/** + the gc-drain script test).
const BUN_FULL_TRIGGERS = new Set(["package.json", "bun.lock", "bunfig.toml", "tsconfig.json", "scripts/test-preload.ts", HERE]);
const bunFullReason = [...changed].find((f) => BUN_FULL_TRIGGERS.has(f));
const inBunSuite = (f: string) => (f.startsWith("src/") && isTest(f)) || f === "scripts/gc-drain.test.ts";
const bunTests = [...affected].filter(inBunSuite).sort();

// API domain: apps/api vitest. Tests hit the composed worker over SELF inside a
// single shared workerd (isolate:false), so anything reaching worker source or
// its config/migrations means the whole suite — per-file selection is only
// sound for pure test-file (+ helper) changes.
const API_FULL_TRIGGERS = ["apps/api/vitest.config.ts", "apps/api/wrangler.jsonc", "apps/api/tsconfig.json", "package.json", "bun.lock"];
const apiFullReason =
  [...changed].find((f) => API_FULL_TRIGGERS.includes(f) || f.startsWith("apps/api/migrations/")) ??
  [...affected].find((f) => f.startsWith("apps/api/src/"));
const apiTests = [...affected].filter((f) => f.startsWith("apps/api/test/") && isTest(f)).sort();

// Affected tests that live OUTSIDE the two nightly suites (rig, storage-truth,
// release tooling): surface them so coverage isn't silently dropped.
const outsideTests = [...affected].filter((f) => isTest(f) && !inBunSuite(f) && !f.startsWith("apps/api/")).sort();

// Changed files whose closure reaches no test in any domain — honesty line.
const coveredByFull = (f: string) => (bunFullReason !== undefined && (f.startsWith("src/") || f.startsWith("scripts/"))) || (apiFullReason !== undefined && f.startsWith("apps/api/"));
const reachesTest = (f: string) => {
  if (isTest(f)) return true;
  const seen = new Set<string>([f]);
  const walk = [f];
  while (walk.length > 0) {
    for (const importer of importers.get(walk.shift()!) ?? []) {
      if (seen.has(importer)) continue;
      if (isTest(importer)) return true;
      seen.add(importer);
      walk.push(importer);
    }
  }
  return false;
};
const untested = [...changed].filter((f) => !coveredByFull(f) && !reachesTest(f)).sort();

// ── report ───────────────────────────────────────────────────────────────────
console.log(`test-affected: ${changed.size} changed file(s) vs ${base.slice(0, 10)}`);

type Run = { label: string; argv: string[]; cwd?: string };
const runs: Run[] = [];
// CI's shard runner uses 15s (shared-runner contention); match it locally.
const BUN_TIMEOUT = ["--timeout", "15000"];

if (bunFullReason) {
  console.log(`  bun: FULL suite (${bunFullReason} changed)`);
  runs.push({ label: "bun test (full)", argv: ["bun", "test", ...BUN_TIMEOUT, "./src/", "./scripts/gc-drain.test.ts"] });
} else if (bunTests.length > 0) {
  console.log(`  bun: ${bunTests.length} affected test file(s)`);
  for (const t of bunTests) console.log(`    ${t}  (${provenance(t)})`);
  runs.push({ label: `bun test (${bunTests.length} files)`, argv: ["bun", "test", ...BUN_TIMEOUT, ...bunTests] });
} else {
  console.log("  bun: nothing affected");
}

if (apiFullReason) {
  console.log(`  api: FULL vitest run (${apiFullReason} affected)`);
  runs.push({ label: "vitest run (full)", argv: ["bun", "x", "vitest", "run"], cwd: path.join(REPO, "apps/api") });
} else if (apiTests.length > 0) {
  console.log(`  api: ${apiTests.length} affected test file(s)`);
  for (const t of apiTests) console.log(`    ${t}  (${provenance(t)})`);
  runs.push({
    label: `vitest run (${apiTests.length} files)`,
    argv: ["bun", "x", "vitest", "run", ...apiTests.map((t) => path.relative("apps/api", t))],
    cwd: path.join(REPO, "apps/api"),
  });
} else {
  console.log("  api: nothing affected");
}

if (outsideTests.length > 0) {
  console.log(`  outside the nightly suites (NOT run — invoke explicitly if relevant):`);
  for (const t of outsideTests) console.log(`    ${t}  (${provenance(t)})`);
}
if (untested.length > 0) {
  console.log(`  changed but reaching no test (verify another way if these matter):`);
  for (const f of untested) console.log(`    ${f}`);
}

if (dryRun) {
  console.log("test-affected: dry run — nothing executed");
  process.exit(0);
}
if (runs.length === 0) {
  console.log("test-affected: no test domain affected — nothing to run");
  process.exit(0);
}

for (const run of runs) {
  console.log(`$ ${run.argv.join(" ")}${run.cwd ? `  (cwd ${path.relative(REPO, run.cwd)})` : ""}`);
  const proc = Bun.spawn(run.argv, { cwd: run.cwd ?? REPO, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`test-affected: ${run.label} FAILED (exit ${code})`);
    process.exit(code);
  }
}
console.log(`test-affected: all selected suites green (${runs.map((r) => r.label).join(", ")})`);
