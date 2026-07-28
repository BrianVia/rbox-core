import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { REPO_RECORD_COLUMN_BY_FIELD } from "../codecs/repo-record.js";
import { STATE_STORE_DDL_FINGERPRINT } from "./application.js";
import { SCHEMA_V1_DDL } from "./v1.js";
import { createStateStore, stateStoreDatabase } from "../store/open.js";
import { stateSemanticDigest } from "../digest/state-semantic-v1.js";

test("frozen repo_records columns stay bijective with the nineteen live RepoRecord members", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-store-columns-"));
  const file = path.join(root, "state.db");
  createStateStore(file, {
    authorityId: "a".repeat(32), lineageId: "b".repeat(32), stream: "s", createdBy: "test",
  }).close();
  const db = new Database(file, { readonly: true });
  const columns = (db.query("PRAGMA table_info(repo_records)").all() as Array<{ name: string }>).map((row) => row.name);
  db.close();
  const infrastructure = new Set([
    "lineage_id", "rel_path", "path_order", "extras_cjson", "canonical_bytes", "retained_estimate",
  ]);
  const ddlFields = columns.filter((column) => !infrastructure.has(column)).sort();
  const mappedFields = [...Object.values(REPO_RECORD_COLUMN_BY_FIELD)].sort();
  const ddlOnly = ddlFields.filter((column) => !mappedFields.includes(column));
  const mappingOnly = mappedFields.filter((column) => !ddlFields.includes(column));
  expect({ ddlOnly, mappingOnly }, "RepoRecord/DDL bijection drifted").toEqual({ ddlOnly: [], mappingOnly: [] });
  expect(new Set(mappedFields).size, "two RepoRecord members map to one SQL column").toBe(mappedFields.length);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the SQLite-free engine never imports bun:sqlite", () => {
  const engine = path.resolve(import.meta.dir, "../../../engine");
  const offenders: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith(".ts") && fs.readFileSync(absolute, "utf8").includes("bun:sqlite")) offenders.push(absolute);
    }
  };
  visit(engine);
  expect(offenders).toEqual([]);
});

test("the production state-plane facade bundles without bun:sqlite", async () => {
  const entrypoint = path.resolve(import.meta.dir, "../index.ts");
  // Build-generated embedded assets (e.g. crypto-worker.bundle.txt) exist only
  // after a full build; a fresh CI checkout lacks them and they carry no import
  // edges, so the bun:sqlite scan is unaffected by leaving them external.
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    write: false,
    external: ["*.bundle.txt"],
  });
  expect(result.success, result.logs.map(String).join("\n")).toBe(true);
  const output = (await Promise.all(result.outputs.map((item) => item.text()))).join("\n");
  expect(output).not.toContain("bun:sqlite");
});

test("the real CLI executable static graph bundles without bun:sqlite", async () => {
  const entrypoint = path.resolve(import.meta.dir, "../../index.ts");
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    write: false,
    splitting: true,
    // Native watcher bindings are selected and embedded per release target;
    // this graph gate is deliberately platform-independent.
    external: [
      "*.bundle.txt",
      "@parcel/watcher-darwin-arm64",
      "@parcel/watcher-linux-arm64-glibc",
      "@parcel/watcher-linux-x64-glibc",
    ],
  });
  expect(result.success, result.logs.map(String).join("\n")).toBe(true);
  const eagerEntries = result.outputs.filter((item) => item.kind === "entry-point");
  expect(eagerEntries, "Bun.build must emit exactly one eager entry chunk").toHaveLength(1);
  // Splitting hoists shared modules into chunks the entry reaches via STATIC
  // chunk imports, so scanning the entry text alone is vacuous: an eagerly
  // loaded bun:sqlite lands in a chunk. Walk the static-import closure from
  // the entry (dynamic `import(...)` edges deliberately excluded — the reset
  // dispatch is lazy by design) and assert no eager chunk touches bun:sqlite.
  const byPath = new Map(result.outputs.map((item) => [path.basename(item.path), item]));
  const seen = new Set<string>();
  const queue = [eagerEntries[0]!];
  while (queue.length > 0) {
    const chunk = queue.pop()!;
    const name = path.basename(chunk.path);
    if (seen.has(name)) continue;
    seen.add(name);
    const text = await chunk.text();
    expect(text, `eager chunk ${name} must not touch bun:sqlite`).not.toContain("bun:sqlite");
    for (const match of text.matchAll(/^\s*import\s[^;]*?from\s*["'](\.\/[^"']+)["']/gm)) {
      const dep = byPath.get(path.basename(match[1]!));
      if (dep) queue.push(dep);
    }
  }
  expect(seen.size, "closure walk must reach beyond the entry when chunks exist")
    .toBeGreaterThanOrEqual(1);
});

test("schema and authority-state logical digest golden vectors are frozen", () => {
  expect(createHash("sha256").update(SCHEMA_V1_DDL).digest("hex")).toBe(STATE_STORE_DDL_FINGERPRINT);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-store-digests-"));
  const handle = createStateStore(path.join(root, "state.db"), {
    authorityId: "a".repeat(32), lineageId: "b".repeat(32), stream: "s", createdBy: "test",
  });
  expect(stateSemanticDigest(stateStoreDatabase(handle)))
    .toBe("01983b922af309c935d8ee15277083ada69cd417fcb9a1229cc1fa1cff2a79c3");
  handle.close();
  fs.rmSync(root, { recursive: true, force: true });
});
