/** Never: pool logic, protocol. */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

let embeddedWorkerPath: string | undefined;
let embeddedWorkerDir: string | undefined;
let cleanupRegistered = false;
let workerPathOverrideForTests: string | undefined;

function isCompiledRuntime(): boolean {
  return import.meta.url.includes("$bunfs");
}

export async function cleanupEmbeddedWorker(): Promise<void> {
  const dir = embeddedWorkerDir;
  embeddedWorkerPath = undefined;
  embeddedWorkerDir = undefined;
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function embeddedWorkerFile(): Promise<string> {
  if (embeddedWorkerPath) return embeddedWorkerPath;
  const mod = (await import("./generated/crypto-worker.bundle.txt", { with: { type: "text" } })) as { default: unknown };
  if (typeof mod.default !== "string" || mod.default.length === 0) {
    throw new Error("embedded crypto worker bundle missing or not text — compiled-binary build issue");
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-crypto-worker-"));
  await fs.chmod(dir, 0o700).catch(() => {});
  const file = path.join(dir, "crypto-worker.bundle.js");
  const fh = await fs.open(file, "wx", 0o600);
  try {
    await fh.writeFile(mod.default);
  } finally {
    await fh.close();
  }
  await fs.chmod(file, 0o600).catch(() => {});
  embeddedWorkerDir = dir;
  embeddedWorkerPath = file;
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once("exit", () => {
      if (embeddedWorkerDir) fsSync.rmSync(embeddedWorkerDir, { recursive: true, force: true });
    });
  }
  return file;
}

export async function workerSpecifier(): Promise<string> {
  if (workerPathOverrideForTests) return workerPathOverrideForTests;
  if (!isCompiledRuntime()) return path.join(MODULE_DIR, "crypto-worker.ts");
  return embeddedWorkerFile();
}

export function setWorkerPathOverrideForTests(pathname: string | undefined): void {
  workerPathOverrideForTests = pathname;
}
