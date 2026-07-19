#!/usr/bin/env bun
import { join } from "node:path";

export const INQUIRER_IMPORT_ERROR =
  "::error::@inquirer may only be imported from src/cli/prompt.ts (STDERR + Ctrl-C invariant)";

const ALLOWED_INQUIRER_IMPORT = "src/cli/prompt.ts";

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
    if (normalizedPath === ALLOWED_INQUIRER_IMPORT) continue;

    const source = await Bun.file(join(root, relativePath)).text();
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (lines[index]!.includes('from "@inquirer')) {
        violations.push(`${normalizedPath}:${index + 1}:${lines[index]}`);
      }
    }
  }

  return violations.sort();
}

async function guardInquirerImports(root: string): Promise<boolean> {
  console.log(`inquirer-import guard: checked src/; only ${ALLOWED_INQUIRER_IMPORT} may import @inquirer`);
  const violations = await findInquirerImportViolations(root);
  if (violations.length === 0) return true;

  for (const violation of violations) console.log(violation);
  console.error(INQUIRER_IMPORT_ERROR);
  return false;
}

export async function runGuards(root = process.cwd()): Promise<boolean> {
  if (!(await guardSrcTestShardCoverage(root))) return false;
  return guardInquirerImports(root);
}

if (import.meta.main && !(await runGuards())) process.exit(1);
