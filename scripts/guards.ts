#!/usr/bin/env bun
import { join } from "node:path";

export const INQUIRER_IMPORT_ERROR =
  "::error::@inquirer is retired; all interactive widgets must use the shared Ink prompt runtime";
export const TUI_IMPORT_ERROR =
  "::error::ink/react may only be imported from src/cli/prompt-ink.tsx";

const ALLOWED_TUI_IMPORT = "src/cli/prompt-ink.tsx";

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
  return guardTuiImports(root);
}

if (import.meta.main && !(await runGuards())) process.exit(1);
