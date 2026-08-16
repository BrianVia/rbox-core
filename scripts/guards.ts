#!/usr/bin/env bun
import { join } from "node:path";
import { DEDICATED_TESTS, FILE_WEIGHTS, SPLIT_FILES, WEIGHTS_MEASURED, WHOLE_FILE_ANTI_AFFINITY } from "./ci-shard-weights.js";

export const INQUIRER_IMPORT_ERROR =
  "::error::@inquirer is retired; all interactive widgets must use the shared Ink prompt runtime";
export const TUI_IMPORT_ERROR =
  "::error::ink/react may only be imported from src/cli/prompt-ink.tsx";
export const BARE_FETCH_ERROR =
  "::error::bare fetch() has no timeout — a black-holed socket hangs the command forever; call fetchWithDeadline/fetchResilient/fetchBufferedGet from src/cli/remote/resilient.ts";

const ALLOWED_TUI_IMPORT = "src/cli/prompt-ink.tsx";
/** The one module allowed to call the global `fetch`: it IS the deadline wrapper. */
const ALLOWED_BARE_FETCH = "src/cli/remote/resilient.ts";

export const SHARD_WEIGHTS_ERROR =
  "::error::scripts/ci-shard-weights.ts no longer carries measured timings — re-measure and commit the table (issue #699: PR #314 silently restored coarse defaults and shards ran 32-242s for three weeks)";

/**
 * Minimum measured entries. Held HERE, not beside the table, so reverting
 * scripts/ci-shard-weights.ts alone trips this guard instead of passing silently.
 */
const MIN_MEASURED_FILE_WEIGHTS = 40;

export async function findShardWeightViolations(root: string): Promise<string[]> {
  const violations: string[] = [];
  const measured = FILE_WEIGHTS.size;
  if (measured < MIN_MEASURED_FILE_WEIGHTS) {
    violations.push(`FILE_WEIGHTS has ${measured} entries, below the measured floor of ${MIN_MEASURED_FILE_WEIGHTS}`);
  }
  const tabled = [...FILE_WEIGHTS.keys(), ...SPLIT_FILES.keys(), ...DEDICATED_TESTS.keys(), ...WHOLE_FILE_ANTI_AFFINITY.keys()];
  for (const file of [...new Set(tabled)].sort()) {
    if (!(await Bun.file(join(root, file)).exists())) violations.push(`weighted test file no longer exists: ${file}`);
  }
  for (const [file, split] of SPLIT_FILES) {
    if (split.partWeights && split.partWeights.length !== split.parts) {
      violations.push(`${file}: ${split.partWeights.length} partWeights for ${split.parts} parts`);
    }
  }
  return violations;
}

async function guardShardWeights(root: string): Promise<boolean> {
  console.log(`shard-weight guard: ${FILE_WEIGHTS.size} measured files (${WEIGHTS_MEASURED})`);
  const violations = await findShardWeightViolations(root);
  for (const violation of violations) console.log(violation);
  if (violations.length) console.error(SHARD_WEIGHTS_ERROR);
  return violations.length === 0;
}

async function guardSrcTestShardCoverage(root: string): Promise<boolean> {
  const processHandle = Bun.spawn(
    [process.execPath, join(import.meta.dir, "ci-shard-tests.ts"), "guard", "--shard-count", "6"],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  return (await processHandle.exited) === 0;
}

export async function findInquirerImportViolations(root: string): Promise<string[]> {
  const glob = new Bun.Glob("src/**/*");
  const violations: string[] = [];

  for await (const relativePath of glob.scan({ cwd: root, dot: true, onlyFiles: true })) {
    const normalizedPath = relativePath.replaceAll("\\", "/");
    const source = await Bun.file(join(root, relativePath)).text();
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (lines[index]!.includes('from "@inquirer') || lines[index]!.includes('import("@inquirer')) {
        violations.push(`${normalizedPath}:${index + 1}:${lines[index]}`);
      }
    }
  }

  return violations.sort();
}

export async function findTuiImportViolations(root: string): Promise<string[]> {
  const glob = new Bun.Glob("src/**/*");
  const violations: string[] = [];
  for await (const relativePath of glob.scan({ cwd: root, dot: true, onlyFiles: true })) {
    const normalizedPath = relativePath.replaceAll("\\", "/");
    if (normalizedPath === ALLOWED_TUI_IMPORT) continue;
    const lines = (await Bun.file(join(root, relativePath)).text()).split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (/(?:from|import\(|require\()\s*[\"'](?:ink|react)(?:\/[^\"']*)?[\"']/.test(lines[index]!)) {
        violations.push(`${normalizedPath}:${index + 1}:${lines[index]}`);
      }
      // The bespoke raw-key reader pattern (deleted from browser-open.ts) must
      // not return: all keypress handling goes through the shared runtime.
      if (/emitKeypressEvents/.test(lines[index]!)) {
        violations.push(`${normalizedPath}:${index + 1}:${lines[index]}`);
      }
    }
  }
  return violations.sort();
}

/**
 * A bare global `fetch()` has NO timeout: a black-holed TCP connection leaves the promise
 * pending forever, and the only escape is Ctrl-C (docs in src/cli/remote/resilient.ts). Every
 * network call under src/cli must therefore go through that module's deadline wrappers.
 *
 * Matches a call — `fetch(` not preceded by a `.` or word character — and deliberately skips
 * comment lines, `*.test.ts(x)` (tests stub and drive the global directly), and method/interface
 * SIGNATURES named `fetch` (a typed first parameter, e.g. `fetch(url: string, …): Promise<…>`),
 * which are declarations rather than unbounded calls.
 */
const BARE_FETCH_CALL = /(?<![.\w$])fetch\s*\(/;
const FETCH_MEMBER_SIGNATURE = /^\s*(?:readonly\s+|async\s+)?fetch\s*\([^)]*:\s*/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

export async function findBareFetchViolations(root: string): Promise<string[]> {
  const glob = new Bun.Glob("src/cli/**/*.{ts,tsx}");
  const violations: string[] = [];
  for await (const relativePath of glob.scan({ cwd: root, dot: true, onlyFiles: true })) {
    const normalizedPath = relativePath.replaceAll("\\", "/");
    if (normalizedPath === ALLOWED_BARE_FETCH) continue;
    if (/\.test\.tsx?$/.test(normalizedPath)) continue;
    const lines = (await Bun.file(join(root, relativePath)).text()).split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (COMMENT_LINE.test(line) || FETCH_MEMBER_SIGNATURE.test(line)) continue;
      if (BARE_FETCH_CALL.test(line)) violations.push(`${normalizedPath}:${index + 1}:${line}`);
    }
  }
  return violations.sort();
}

async function guardBareFetch(root: string): Promise<boolean> {
  console.log(`bare-fetch guard: global fetch() only in ${ALLOWED_BARE_FETCH}`);
  const violations = await findBareFetchViolations(root);
  for (const violation of violations) console.log(violation);
  if (violations.length) console.error(BARE_FETCH_ERROR);
  return violations.length === 0;
}

async function guardTuiImports(root: string): Promise<boolean> {
  console.log(`tui-import guard: @inquirer forbidden; ink/react only in ${ALLOWED_TUI_IMPORT}`);
  const inquirer = await findInquirerImportViolations(root);
  const tui = await findTuiImportViolations(root);
  for (const violation of [...inquirer, ...tui]) console.log(violation);
  if (inquirer.length) console.error(INQUIRER_IMPORT_ERROR);
  if (tui.length) console.error(TUI_IMPORT_ERROR);
  return inquirer.length === 0 && tui.length === 0;
}

export async function runGuards(root = process.cwd()): Promise<boolean> {
  if (!(await guardSrcTestShardCoverage(root))) return false;
  const shardWeights = await guardShardWeights(root);
  const tui = await guardTuiImports(root);
  const bareFetch = await guardBareFetch(root);
  return shardWeights && tui && bareFetch;
}

if (import.meta.main && !(await runGuards())) process.exit(1);
