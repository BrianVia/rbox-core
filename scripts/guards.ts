#!/usr/bin/env bun
import { join } from "node:path";

export const INQUIRER_IMPORT_ERROR =
  "::error::@inquirer is retired; all interactive widgets must use the shared Ink prompt runtime";
export const TUI_IMPORT_ERROR =
  "::error::ink/react may only be imported from src/cli/prompt-ink.tsx";
export const BARE_FETCH_ERROR =
  "::error::bare fetch() has no timeout — a black-holed socket hangs the command forever; call fetchWithDeadline/fetchResilient/fetchBufferedGet from src/cli/remote/resilient.ts";

const ALLOWED_TUI_IMPORT = "src/cli/prompt-ink.tsx";
/** The one module allowed to call the global `fetch`: it IS the deadline wrapper. */
const ALLOWED_BARE_FETCH = "src/cli/remote/resilient.ts";

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
  const tui = await guardTuiImports(root);
  const bareFetch = await guardBareFetch(root);
  return tui && bareFetch;
}

if (import.meta.main && !(await runGuards())) process.exit(1);
