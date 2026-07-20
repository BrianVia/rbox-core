import fs from "node:fs/promises";
import path from "node:path";
import { fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";

export interface WorkspaceCacheGeneration {
  version: 1;
  generation: number;
  requireFullScan: true;
  reason: "adopt-complete" | "adopt-abort";
  changedAt: string;
  acknowledgements: Record<string, { generation: number; at: string }>;
}

export const cacheGenerationPath = (root: string): string => path.join(root, ".rbox", "state", "cache-generation.json");

export async function readCacheGeneration(root: string): Promise<WorkspaceCacheGeneration | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(cacheGenerationPath(root), "utf8")) as Partial<WorkspaceCacheGeneration>;
    if (value.version !== 1 || !Number.isSafeInteger(value.generation) || (value.generation ?? -1) < 1
      || value.requireFullScan !== true || (value.reason !== "adopt-complete" && value.reason !== "adopt-abort")
      || typeof value.changedAt !== "string" || !value.acknowledgements || typeof value.acknowledgements !== "object") {
      throw new Error("invalid workspace cache generation");
    }
    return value as WorkspaceCacheGeneration;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error("invalid workspace cache generation");
    throw error;
  }
}

async function save(root: string, value: WorkspaceCacheGeneration): Promise<void> {
  const file = cacheGenerationPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(value)}\n`, { mode: 0o600, exactMode: true });
  await fsyncDirectory(path.dirname(file));
}

/** Delete every persistent scan/trackedness hint, then durably advance generation. */
export async function invalidateAdoptionCaches(
  root: string,
  reason: WorkspaceCacheGeneration["reason"],
): Promise<{ before: number; after: number }> {
  const prior = await readCacheGeneration(root);
  const before = prior?.generation ?? 0;
  const stateDir = path.join(root, ".rbox", "state");
  for (const rel of ["hashcache.json", "dircache.json", "scan-probe.json", "git-divergence.json"]) {
    await fs.rm(path.join(stateDir, rel), { force: true });
  }
  await fs.rm(path.join(stateDir, "git-tracked"), { recursive: true, force: true });
  await fsyncDirectory(stateDir);
  const after = before + 1;
  await save(root, {
    version: 1,
    generation: after,
    requireFullScan: true,
    reason,
    changedAt: new Date().toISOString(),
    acknowledgements: {},
  });
  return { before, after };
}

export async function acknowledgeCacheGeneration(root: string, generation: number, owner: string): Promise<void> {
  if (!owner || owner.includes("\0")) throw new Error("invalid cache-generation owner");
  const current = await readCacheGeneration(root);
  if (!current || current.generation !== generation) return;
  current.acknowledgements[owner] = { generation, at: new Date().toISOString() };
  await save(root, current);
}

