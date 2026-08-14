import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

const exec = promisify(execFile);

let gitSpawnObserver: ((root: string, args: readonly string[]) => void) | undefined;

/** Test seam for status-performance assertions: counts git subprocesses without
 *  changing production behavior. */
export function setGitSpawnObserver(observer: ((root: string, args: readonly string[]) => void) | undefined): void {
  gitSpawnObserver = observer;
}

/** Remove repository-routing variables inherited from hooks/wrappers. */
export function cleanGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Reflog writes require an identity even on fresh receivers. This fallback
    // is local forensic text only; rbox never authors user commits with it.
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "rbox",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "rbox@local",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "rbox",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "rbox@local",
    GIT_DIR: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    ...extra,
  } as NodeJS.ProcessEnv;
}

/** Run Git without altering stdout bytes. Required for NUL-delimited config reads,
 * where trimming would erase a successful empty value. */
export interface GitRunOptions {
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  /** Streams stdout without retaining it in the runner's result buffer. */
  onStdoutChunk?: (chunk: string) => void;
}

async function gitRawLegacy(root: string, args: string[], opts: GitRunOptions = {}): Promise<string> {
  gitSpawnObserver?.(root, args);
  if (opts.stdin !== undefined || opts.onStdoutChunk) {
    // Match runUpdateRefTransaction's Node-spawn path so stdin is reliable under Bun.
    const stdinDir = opts.stdin === undefined ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), "rbox-git-stdin-"));
    let stdinFile: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      if (stdinDir) {
        const stdinPath = path.join(stdinDir, "input");
        await fs.writeFile(stdinPath, opts.stdin!);
        stdinFile = await fs.open(stdinPath, "r");
      }
      return await new Promise<string>((resolve, reject) => {
        const child = spawn("git", ["-C", root, ...args], {
          env: cleanGitEnv(opts.env),
          stdio: [stdinFile?.fd ?? "pipe", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let exitCode: number | null | undefined;
        let stdoutEnded = false;
        let stderrEnded = false;
        let settled = false;
        let bufferError: Error | undefined;
        const streamDecoder = opts.onStdoutChunk ? new StringDecoder("utf8") : undefined;
        const maxBuffer = opts.maxBuffer ?? 16 * 1024 * 1024;
        const finish = () => {
          if (settled || exitCode === undefined || !stdoutEnded || !stderrEnded) return;
          settled = true;
          if (bufferError) {
            Object.assign(bufferError, {
              stdout: Buffer.concat(stdout).toString(),
              stderr: Buffer.concat(stderr).toString(),
            });
            reject(bufferError);
          }
          else if (exitCode === 0) resolve(opts.onStdoutChunk ? "" : Buffer.concat(stdout).toString());
          else reject(Object.assign(
            new Error(Buffer.concat(stderr).toString() || `git exited with status ${exitCode ?? "unknown"}`),
            {
              code: exitCode,
              stdout: opts.onStdoutChunk ? "" : Buffer.concat(stdout).toString(),
              stderr: Buffer.concat(stderr).toString(),
            },
          ));
        };
        child.stdout!.on("data", (value: Buffer) => {
          if (settled) return;
          if (opts.onStdoutChunk) {
            try {
              const decoded = streamDecoder!.write(value);
              if (decoded) opts.onStdoutChunk(decoded);
            }
            catch (error) {
              settled = true;
              child.kill();
              reject(error);
            }
          }
          else {
            stdoutBytes += value.length;
            if (stdoutBytes <= maxBuffer) stdout.push(value);
            else { bufferError = new Error("git stdout exceeded maxBuffer"); child.kill(); }
          }
        });
        child.stdout!.on("end", () => {
          if (!settled && opts.onStdoutChunk) {
            try {
              const tail = streamDecoder!.end();
              if (tail) opts.onStdoutChunk(tail);
            } catch (error) {
              settled = true;
              reject(error);
            }
          }
          stdoutEnded = true;
          finish();
        });
        child.stderr!.on("data", (value: Buffer) => {
          stderrBytes += value.length;
          if (stderrBytes <= maxBuffer) stderr.push(value);
          else { bufferError = new Error("git stderr exceeded maxBuffer"); child.kill(); }
        });
        child.stderr!.on("end", () => { stderrEnded = true; finish(); });
        child.on("error", (error) => { if (!settled) { settled = true; reject(error); } });
        child.on("close", (code) => {
          exitCode = code;
          finish();
        });
        child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "EPIPE" && !settled) { settled = true; reject(error); }
        });
        child.stdin?.end();
      });
    } finally {
      await stdinFile?.close();
      if (stdinDir) await fs.rm(stdinDir, { recursive: true, force: true });
    }
  }
  const { stdout } = await exec("git", ["-C", root, ...args], {
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    // Never let a hook or wrapper redirect this operation into a foreign repo.
    env: cleanGitEnv(opts.env),
  });
  return stdout.toString();
}

export type GitRunResult =
  | { status: "ok"; stdout: string }
  | { status: "failed"; exit: number | null; stdout: string; stderr: string; cause: unknown };

type GitLegacyFailure = { code?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };

function gitFailureOutput(output: string | Buffer | undefined): string {
  return Buffer.isBuffer(output) ? output.toString() : output ?? "";
}

/** Structured Git runner for evidence-sensitive reads. Every outcome is data,
 * and `cause` is the exact object the legacy throwing runner produced. */
export async function gitStatus(root: string, args: string[], opts: GitRunOptions = {}): Promise<GitRunResult> {
  try {
    return { status: "ok", stdout: await gitRawLegacy(root, args, opts) };
  } catch (cause) {
    // Decode Node's process failure shape while preserving the exact cause.
    const error = cause as GitLegacyFailure;
    return {
      status: "failed",
      exit: Number.isInteger(error.code) ? error.code ?? null : null,
      stdout: gitFailureOutput(error.stdout),
      stderr: gitFailureOutput(error.stderr),
      cause,
    };
  }
}

export async function gitRaw(root: string, args: string[], opts: GitRunOptions = {}): Promise<string> {
  const result = await gitStatus(root, args, opts);
  if (result.status === "ok") return result.stdout;
  throw result.cause;
}

export async function git(root: string, args: string[], opts: GitRunOptions = {}): Promise<string> {
  return (await gitRaw(root, args, opts)).trim();
}

export async function gitWithIndexFile(root: string, indexFile: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  gitSpawnObserver?.(root, args);
  const { stdout } = await exec("git", ["-C", root, ...args], {
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    env: cleanGitEnv({ GIT_INDEX_FILE: indexFile }),
  });
  return stdout.toString().trim();
}

export async function gitOk(root: string, args: string[]): Promise<boolean> {
  try {
    await git(root, args);
    return true;
  } catch {
    return false;
  }
}
