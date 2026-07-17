import { createHash } from "node:crypto";
import path from "node:path";
import type { Manifest } from "../src/cli/release-verify.js";

const STDERR_LIMIT = 64 * 1024;

export interface ReleaseObjectStore {
  put(key: string, file: string, contentType: string): Promise<void>;
  sha256(key: string): Promise<string>;
}

interface Operation {
  key: string;
  run: () => Promise<unknown>;
}

async function settlePhase(label: string, operations: Operation[]): Promise<void> {
  // Defer every invocation through a promise so a synchronous adapter throw
  // cannot prevent later siblings from starting.
  const pending = operations.map((operation) => Promise.resolve().then(operation.run));
  const results = await Promise.allSettled(pending);
  const failures = results.flatMap((result, index) => result.status === "rejected"
    ? [`${operations[index]!.key}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
    : []);
  if (failures.length > 0) throw new Error(`${label} failed:\n${failures.join("\n")}`);
}

export async function publishReleaseObjects(opts: {
  manifest: Manifest;
  dist: string;
  store: ReleaseObjectStore;
}): Promise<void> {
  const artifacts = Object.entries(opts.manifest.artifacts);
  await settlePhase("immutable release upload", artifacts.map(([name, artifact]) => ({
    key: `releases/${artifact.path}`,
    run: () => opts.store.put(`releases/${artifact.path}`, path.join(opts.dist, name), "application/octet-stream"),
  })));

  await settlePhase("immutable release verification", artifacts.map(([name, artifact]) => ({
    key: `releases/${artifact.path}`,
    run: async () => {
      const actual = await opts.store.sha256(`releases/${artifact.path}`);
      if (actual !== artifact.sha256) throw new Error(`sha256 ${actual} != signed ${artifact.sha256} for ${name}`);
    },
  })));

  // Mutable channel state remains intentionally sequential. §150 improves the
  // immutable phase without changing the existing multi-object activation
  // semantics; clients fail closed on any transient mixed state.
  for (const [name] of artifacts) {
    await putMutable(opts.store, `releases/${name}`, path.join(opts.dist, name), "application/octet-stream");
  }
  await putMutable(opts.store, "releases/install.sh", path.join(opts.dist, "../scripts/install.sh"), "text/x-shellscript");
  await putMutable(opts.store, "releases/version.json", path.join(opts.dist, "version.json"), "application/json");
  await putMutable(opts.store, "releases/version.json.sig", path.join(opts.dist, "version.json.sig"), "text/plain");
}

async function putMutable(store: ReleaseObjectStore, key: string, file: string, contentType: string): Promise<void> {
  try {
    await store.put(key, file, contentType);
  } catch (error) {
    throw new Error(`${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function drainBounded(stream: ReadableStream<Uint8Array> | null, limit = STDERR_LIMIT): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (kept < limit) {
      const slice = value.subarray(0, Math.min(value.length, limit - kept));
      chunks.push(slice);
      kept += slice.length;
    }
  }
  const bytes = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes).trim();
}

async function hashStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return hash.digest("hex");
}

export async function settleWranglerProcess<T>(opts: {
  operation: string;
  exited: Promise<number>;
  output: Promise<T>;
  stderr: Promise<string>;
}): Promise<T> {
  const [exitResult, outputResult, stderrResult] = await Promise.allSettled([opts.exited, opts.output, opts.stderr]);
  const stderr = stderrResult.status === "fulfilled" ? stderrResult.value : "";
  const failures: string[] = [];
  if (exitResult.status === "rejected") failures.push(`exit wait failed: ${String(exitResult.reason)}`);
  else if (exitResult.value !== 0) failures.push(`exited ${exitResult.value}`);
  if (outputResult.status === "rejected") failures.push(`output failed: ${String(outputResult.reason)}`);
  if (stderrResult.status === "rejected") failures.push(`stderr drain failed: ${String(stderrResult.reason)}`);
  if (failures.length > 0) throw new Error(`${opts.operation} ${failures.join("; ")}${stderr ? `: ${stderr}` : ""}`);
  if (outputResult.status !== "fulfilled") throw new Error(`${opts.operation} output did not settle successfully`);
  return outputResult.value;
}

export function wranglerReleaseStore(opts: {
  cwd: string;
  wrangler: string;
}): ReleaseObjectStore {
  const command = (...args: string[]) => ["bunx", opts.wrangler, "r2", "object", ...args, "--remote"];
  return {
    async put(key, file, contentType) {
      const proc = Bun.spawn(command("put", `rbox-releases/${key}`, `--file=${file}`, `--content-type=${contentType}`), {
        cwd: opts.cwd,
        stdout: "inherit",
        stderr: "pipe",
      });
      await settleWranglerProcess({
        operation: `wrangler put ${key}`,
        exited: proc.exited,
        output: Promise.resolve(undefined),
        stderr: drainBounded(proc.stderr),
      });
    },
    async sha256(key) {
      const proc = Bun.spawn(command("get", `rbox-releases/${key}`, "--pipe"), {
        cwd: opts.cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      return await settleWranglerProcess({
        operation: `wrangler get ${key}`,
        exited: proc.exited,
        output: hashStream(proc.stdout),
        stderr: drainBounded(proc.stderr),
      });
    },
  };
}
