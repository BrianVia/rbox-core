import fs from "node:fs";
import path from "node:path";
import { bulkWalkDir, bulkWalkSupported, type BulkStat } from "../src/engine/darwin-bulk-walk.js";

const root = process.argv[2];
if (!root) {
  console.error("usage: bun scripts/bulk-parity.ts <dir>");
  process.exit(2);
}
if (!bulkWalkSupported()) {
  console.error("getattrlistbulk is unavailable (this harness requires macOS)");
  process.exit(2);
}

let mismatches = 0;
function mismatch(file: string, field: string, bulk: unknown, lstat: unknown, stat?: BulkStat): void {
  mismatches++;
  const raw = field === "mtimeMs" ? stat?.rawTimes && `${stat.rawTimes.mtimeSec}s ${stat.rawTimes.mtimeNsec}ns`
    : field === "ctimeMs" ? stat?.rawTimes && `${stat.rawTimes.ctimeSec}s ${stat.rawTimes.ctimeNsec}ns` : undefined;
  console.error(`${file}: ${field}: bulk=${String(bulk)} lstat=${String(lstat)}${raw ? ` raw=${raw}` : ""}`);
}

const dirs = [path.resolve(root)];
while (dirs.length > 0) {
  const dir = dirs.pop()!;
  const bulk = bulkWalkDir(dir);
  if (bulk === null) { mismatch(dir, "bulkWalkDir", null, "success"); continue; }
  const disk = fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? [[entry.name, "dir"]]
    : entry.isSymbolicLink() ? [[entry.name, "symlink"]] : entry.isFile() ? [[entry.name, "file"]] : []);
  const inventory = (rows: string[][]) => rows.map(([name, type]) => `${name}\0${type}`).sort();
  const got = inventory(bulk.map((entry) => [entry.name, entry.type]));
  const expected = inventory(disk);
  const gotSet = new Set(got);
  const expectedSet = new Set(expected);
  if (gotSet.size !== got.length) mismatch(dir, "inventory.duplicates", JSON.stringify(got), "none");
  for (const item of gotSet) if (!expectedSet.has(item)) mismatch(path.join(dir, item.split("\0")[0]!), "inventory", item.split("\0")[1], "absent/different");
  for (const item of expectedSet) if (!gotSet.has(item)) mismatch(path.join(dir, item.split("\0")[0]!), "inventory", "absent/different", item.split("\0")[1]);
  for (const child of bulk) {
    const file = path.join(dir, child.name);
    const st = fs.lstatSync(file);
    if (child.type === "dir") dirs.push(file);
    if (child.type !== "file") continue;
    if (!child.stat) { mismatch(file, "stat", "missing", "present"); continue; }
    for (const field of ["size", "mtimeMs", "ctimeMs", "mode", "ino", "dev"] as const) {
      if (child.stat[field] !== st[field]) mismatch(file, field, child.stat[field], st[field], child.stat);
    }
  }
}
console.log(`bulk parity: ${mismatches === 0 ? "ok" : `${mismatches} mismatch(es)`}`);
process.exitCode = mismatches === 0 ? 0 : 1;
