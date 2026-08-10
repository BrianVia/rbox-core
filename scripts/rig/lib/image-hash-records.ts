import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunnerName } from "./container.js";

export type ImageHashRecords = Partial<Record<RunnerName, string>>;

/** Shared rig/regress cache state lives outside the source checkout. */
export function imageHashRecordPath(tempRoot = os.tmpdir()): string {
  return path.join(tempRoot, "rbox-rig", "image-hashes.json");
}

export function parseImageHashRecords(text: string): ImageHashRecords {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("image-hash records must be an object");
  const record = parsed as Partial<Record<RunnerName, unknown>>;
  const out: ImageHashRecords = {};
  for (const runner of ["apple-container", "docker"] as const) {
    const value = record[runner];
    if (value !== undefined && typeof value !== "string") throw new Error(`image-hash record ${runner} must be a string`);
    if (typeof value === "string") out[runner] = value;
  }
  return out;
}

export function readImageHashRecord(file: string, runner: RunnerName): string | undefined {
  try { return parseImageHashRecords(fs.readFileSync(file, "utf8"))[runner]; } catch { return undefined; }
}

export function writeImageHashRecord(file: string, runner: RunnerName, hash: string): void {
  let records: ImageHashRecords = {};
  try { records = parseImageHashRecords(fs.readFileSync(file, "utf8")); } catch { /* replace legacy/malformed scalar */ }
  records[runner] = hash;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(records, null, 2) + "\n");
}

export function deleteImageHashRecord(file: string, runner: RunnerName): void {
  let records: ImageHashRecords;
  try { records = parseImageHashRecords(fs.readFileSync(file, "utf8")); } catch { fs.rmSync(file, { force: true }); return; }
  delete records[runner];
  if (Object.keys(records).length === 0) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, JSON.stringify(records, null, 2) + "\n");
}
