export type AstSweepMode = "base-composer-structure" | "state-plane-inventory";

interface AstSweepSpawnOptions {
  stdin: "ignore";
  stdout: "pipe";
  stderr: "pipe";
}

interface AstSweepSpawnResult {
  success: boolean;
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface AstSweepDeps {
  spawn(command: string[], options: AstSweepSpawnOptions): AstSweepSpawnResult;
  sleep(milliseconds: number): void;
}

export interface AstSweepOutput {
  parsed: unknown;
  stdoutLength: number;
}

interface BunRuntime {
  spawnSync(command: string[], options: AstSweepSpawnOptions): AstSweepSpawnResult;
  sleepSync(milliseconds: number): void;
}

const ATTEMPTS = 3;
const decoder = new TextDecoder();
const bun = (globalThis as typeof globalThis & { Bun: BunRuntime }).Bun;
const defaultDeps: AstSweepDeps = {
  spawn: (command, options) => bun.spawnSync(command, options),
  sleep: (milliseconds) => bun.sleepSync(milliseconds),
};

export function runAstSweep(
  script: string,
  repo: string,
  mode: AstSweepMode,
  deps: AstSweepDeps = defaultDeps,
): AstSweepOutput {
  let finalFailure = "unknown failure";
  let finalResult: AstSweepSpawnResult | undefined;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const result = deps.spawn(["node", script, repo, mode], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    finalResult = result;

    if (!result.success) {
      finalFailure = "child process was unsuccessful";
    } else if (result.stdout.byteLength === 0) {
      finalFailure = "stdout was empty";
    } else {
      try {
        const parsed: unknown = JSON.parse(decoder.decode(result.stdout));
        if (!Array.isArray(parsed)) {
          finalFailure = "stdout JSON was not an array";
        } else {
          return { parsed, stdoutLength: result.stdout.byteLength };
        }
      } catch (error) {
        finalFailure = `stdout was not parseable JSON: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    if (attempt < ATTEMPTS) deps.sleep(attempt * 10);
  }

  const stderr = finalResult ? decoder.decode(finalResult.stderr) : "";
  throw new Error(
    `AST sweep failed after ${ATTEMPTS} attempts (${mode}): ${finalFailure}; `
    + `child exit code ${finalResult?.exitCode ?? "unavailable"}; `
    + `stderr: ${stderr || "<empty>"}; stdout length ${finalResult?.stdout.byteLength ?? 0} bytes`,
  );
}
