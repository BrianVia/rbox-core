import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertResetLegacyArtifactsValid,
  hasResetLineageProvenance,
  inventoryResetNamespace,
  RESET_NAMESPACE_CHURN_RETRY_LIMIT,
  RESET_NAMESPACE_ENTRY_LIMIT,
  ResetNamespaceInventoryError,
  resetDbArtifacts,
  resetInventoryHasNonS0,
} from "./reset-namespace-inventory.js";
import { loadState, resetSyncState } from "./config.js";

const NONCE = "1".repeat(32);
const HASH = "2".repeat(64);
const JOURNAL_ID = "3".repeat(32);
const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-inventory-"));
  roots.push(root);
  return root;
}

async function stateDir(root: string): Promise<string> {
  const directory = path.join(root, ".rbox", "state");
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("reset namespace DB inventory", () => {
  test("observes active, every sidecar vector, and a sidecar without its main", async () => {
    const root = await workspace();
    const state = await stateDir(root);
    await fs.writeFile(path.join(state, "state.db"), "active");
    await fs.writeFile(path.join(state, "state.db-shm"), "");
    const candidates = path.join(state, "reset-candidates");
    await fs.mkdir(candidates);
    await fs.writeFile(path.join(candidates, `${JOURNAL_ID}.db-wal`), "");
    const lineages = path.join(state, "lineages", NONCE);
    await fs.mkdir(lineages, { recursive: true });
    await fs.writeFile(path.join(lineages, `${HASH}.db`), "archive");
    await fs.writeFile(path.join(lineages, `${HASH}.db-journal`), "");

    const inventory = await inventoryResetNamespace(root);
    expect(inventory.active.sidecarVector).toBe("SW");
    expect(inventory.candidates[0]).toMatchObject({
      main: "absent",
      wal: "regular",
      sidecarVector: "other",
    });
    expect(inventory.archives[0]).toMatchObject({
      main: "regular",
      rollbackJournal: "regular",
      sidecarVector: "other",
    });
    expect(resetDbArtifacts(inventory)).toHaveLength(3);
    expect(resetInventoryHasNonS0(inventory)).toBe(true);
  });

  test("pins WAL-only, SHM-only, WAL+SHM, S0, and malformed sidecars", async () => {
    const variants = [
      { suffixes: [] as string[], expected: "S0" },
      { suffixes: ["-wal"], expected: "SW" },
      { suffixes: ["-shm"], expected: "SW" },
      { suffixes: ["-wal", "-shm"], expected: "SW" },
      { suffixes: ["-journal"], expected: "other" },
    ] as const;
    for (const [index, variant] of variants.entries()) {
      const root = await workspace();
      const state = await stateDir(root);
      const main = path.join(state, "state.db");
      await fs.writeFile(main, "db");
      for (const suffix of variant.suffixes) await fs.writeFile(`${main}${suffix}`, "");
      expect((await inventoryResetNamespace(root)).active.sidecarVector).toBe(variant.expected);
      expect(index).toBeGreaterThanOrEqual(0);
    }
  });

  test("records nonregular recognized leaves as other without following symlinks", async () => {
    const root = await workspace();
    const state = await stateDir(root);
    const candidates = path.join(state, "reset-candidates");
    await fs.mkdir(candidates);
    const outside = path.join(root, "outside");
    await fs.writeFile(outside, "secret");
    await fs.symlink(outside, path.join(candidates, `${JOURNAL_ID}.db`));
    await fs.mkdir(path.join(candidates, `${"4".repeat(32)}.db`));

    const inventory = await inventoryResetNamespace(root);
    expect(inventory.candidates.map((entry) => entry.main)).toEqual(["other", "other"]);
  });
});

describe("retained JSON branch and provenance", () => {
  test("inventories same-stem db/json leaves separately and both archive branches prove provenance", async () => {
    const root = await workspace();
    const state = await stateDir(root);
    const candidates = path.join(state, "reset-candidates");
    const lineages = path.join(state, "lineages", NONCE);
    await fs.mkdir(candidates);
    await fs.mkdir(lineages, { recursive: true });
    await fs.writeFile(path.join(candidates, `${JOURNAL_ID}.db`), "db");
    await fs.writeFile(path.join(candidates, `${JOURNAL_ID}.json`), "json");
    await fs.writeFile(path.join(lineages, `${HASH}.db`), "db");
    await fs.writeFile(path.join(lineages, `${HASH}.json`), "json");

    const inventory = await inventoryResetNamespace(root);
    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.legacyCandidates).toHaveLength(1);
    expect(inventory.archives).toHaveLength(1);
    expect(inventory.legacyArchives).toHaveLength(1);
    expect(await hasResetLineageProvenance(root)).toBe(true);
  });

  test("db-only and json-only archives each prove provenance; legacy-other does not", async () => {
    for (const suffix of ["db", "json"]) {
      const root = await workspace();
      const directory = path.join(await stateDir(root), "lineages", NONCE);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, `${HASH}.${suffix}`), "archive");
      expect(await hasResetLineageProvenance(root)).toBe(true);
    }

    const root = await workspace();
    const directory = path.join(await stateDir(root), "lineages", NONCE);
    await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(path.join(directory, `${HASH}.json`));
    const inventory = await inventoryResetNamespace(root);
    expect(inventory.legacyArchives[0]?.status).toBe("legacy-other");
    expect(await hasResetLineageProvenance(root)).toBe(false);
    expect(() => assertResetLegacyArtifactsValid(inventory)).toThrow(expect.objectContaining({
      code: "RESET_LEGACY_ARTIFACT_INVALID",
      artifactType: "legacy-other",
    }));
  });
});

describe("bounded namespace and frozen temp grammar", () => {
  test("pins the normative entry and churn-retry limits", () => {
    expect(RESET_NAMESPACE_ENTRY_LIMIT).toBe(16_384);
    expect(RESET_NAMESPACE_CHURN_RETRY_LIMIT).toBe(3);
  });

  test("admits exact decimal and hex temp forms as inert", async () => {
    const root = await workspace();
    const candidates = path.join(await stateDir(root), "reset-candidates");
    const lineage = path.join(path.dirname(candidates), "lineages", NONCE);
    await fs.mkdir(candidates);
    await fs.mkdir(lineage, { recursive: true });
    await fs.writeFile(path.join(candidates, ".rbox-tmp-12-34-reset-v1.json"), "");
    await fs.writeFile(path.join(lineage, ".rbox-tmp-12-0123456789abcdef-COMMITTED"), "");

    const inventory = await inventoryResetNamespace(root);
    expect(inventory.inertTemps).toHaveLength(2);
    expect(inventory.entryCount).toBe(5);
    expect(resetDbArtifacts(inventory)).toHaveLength(1);
  });

  test("discovers journal/marker publication temps directly under the state root", async () => {
    const root = await workspace();
    const state = await stateDir(root);
    const temp = path.join(state, ".rbox-tmp-123-9-reset-v1.json");
    await fs.writeFile(temp, "");
    await fs.writeFile(path.join(state, "ordinary-unrelated-state-file.json"), "");

    const inventory = await inventoryResetNamespace(root);
    expect(inventory.inertTemps).toEqual([temp]);
    expect(inventory.entryCount).toBe(2);

    await fs.writeFile(path.join(state, ".rbox-tmp-123-0123456789ABCDE-reset-v1.json"), "");
    await expect(inventoryResetNamespace(root)).rejects.toMatchObject({
      code: "RESET_NAMESPACE_INVALID",
      artifactType: "invalid-reserved-name",
    });
  });

  test.each([
    ".rbox-tmp--1-state.db",
    ".rbox-tmp-12345678901-1-state.db",
    ".rbox-tmp-1-ABCDEF0123456789-state.db",
    ".rbox-tmp-1-0123456789abcde-state.db",
    ".rbox-tmp-1-2-",
    "unknown.db",
  ])("rejects temp/name near-miss %s", async (name) => {
    const root = await workspace();
    const candidates = path.join(await stateDir(root), "reset-candidates");
    await fs.mkdir(candidates);
    await fs.writeFile(path.join(candidates, name), "");
    await expect(inventoryResetNamespace(root)).rejects.toMatchObject({
      code: "RESET_NAMESPACE_INVALID",
      artifactType: "invalid-reserved-name",
    });
  });

  test("strict reset inventory rejects the load-path stray-file repros", async () => {
    for (const [relativeDirectory, name] of [
      ["lineages", ".DS_Store"],
      ["reset-candidates", "README"],
    ] as const) {
      const root = await workspace();
      const directory = path.join(await stateDir(root), relativeDirectory);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, name), "stray");
      await expect(inventoryResetNamespace(root)).rejects.toMatchObject({
        code: "RESET_NAMESPACE_INVALID",
        artifactPath: path.join(directory, name),
        artifactType: "invalid-reserved-name",
      });
    }
  });

  test("accepts the entry limit exactly and rejects the next entry", async () => {
    const root = await workspace();
    const candidates = path.join(await stateDir(root), "reset-candidates");
    await fs.mkdir(candidates);
    await fs.writeFile(path.join(candidates, ".rbox-tmp-1-1-a"), "");
    await fs.writeFile(path.join(candidates, ".rbox-tmp-1-2-b"), "");
    expect((await inventoryResetNamespace(root, { entryLimit: 3 })).entryCount).toBe(3);
    await fs.writeFile(path.join(candidates, ".rbox-tmp-1-3-c"), "");
    await expect(inventoryResetNamespace(root, { entryLimit: 3 })).rejects.toMatchObject({
      code: "RESET_NAMESPACE_INVALID",
      artifactType: "entry-limit-overflow",
    });
  });

  test("pins the normative 16,383 / 16,384 / 16,385 namespace boundary", async () => {
    const root = await workspace();
    const candidates = path.join(await stateDir(root), "reset-candidates");
    await fs.mkdir(candidates);
    const createThrough = async (last: number): Promise<void> => {
      for (let start = 1; start <= last; start += 512) {
        await Promise.all(Array.from(
          { length: Math.min(512, last - start + 1) },
          (_, offset) => fs.writeFile(path.join(candidates, `.rbox-tmp-1-${start + offset}-entry`), ""),
        ));
      }
    };
    // The reset-candidates directory itself is one state-root entry.
    await createThrough(16_382);
    expect((await inventoryResetNamespace(root)).entryCount).toBe(16_383);
    await createThrough(16_383);
    expect((await inventoryResetNamespace(root)).entryCount).toBe(16_384);
    await createThrough(16_384);
    await expect(inventoryResetNamespace(root)).rejects.toMatchObject({
      code: "RESET_NAMESPACE_INVALID",
      artifactType: "entry-limit-overflow",
    });
  }, 30_000);

  test("retries a churned directory and returns typed busy after three attempts", async () => {
    const root = await workspace();
    const candidates = path.join(await stateDir(root), "reset-candidates");
    await fs.mkdir(candidates);
    let calls = 0;
    const recovered = await inventoryResetNamespace(root, {
      afterDirectoryRead: async (directory, attempt) => {
        if (directory !== candidates || attempt !== 1) return;
        calls += 1;
        await fs.writeFile(path.join(candidates, ".rbox-tmp-1-1-retry"), "");
      },
    });
    expect(calls).toBe(1);
    expect(recovered.inertTemps).toHaveLength(1);

    await expect(inventoryResetNamespace(root, {
      afterDirectoryRead: async (directory, attempt) => {
        if (directory === candidates) {
          await fs.writeFile(path.join(candidates, `.rbox-tmp-1-${attempt + 1}-busy`), "");
        }
      },
    })).rejects.toMatchObject({
      code: "RESET_NAMESPACE_BUSY",
      artifactType: "directory-identity-churn",
    });
  });

  test("rejects invalid roots, depth, and reserved names with exact typed paths", async () => {
    const root = await workspace();
    const state = await stateDir(root);
    const candidates = path.join(state, "reset-candidates");
    await fs.mkdir(candidates);
    const bad = path.join(candidates, "nested");
    await fs.mkdir(bad);
    try {
      await inventoryResetNamespace(root);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ResetNamespaceInventoryError);
      expect(error).toMatchObject({
        code: "RESET_NAMESPACE_INVALID",
        artifactPath: bad,
        artifactType: "invalid-reserved-name",
      });
    }
  });

  test("propagates inventory errors from the provenance predicate", async () => {
    const root = await workspace();
    const state = await stateDir(root);
    const lineages = path.join(state, "lineages");
    await fs.symlink(path.join(root, "elsewhere"), lineages);
    await expect(hasResetLineageProvenance(root)).rejects.toMatchObject({
      code: "RESET_NAMESPACE_INVALID",
      artifactPath: lineages,
      artifactType: "directory-symlink",
    });
  });

  test("does not treat a sidecar-only SQLite archive as lineage provenance", async () => {
    const root = await workspace();
    const lineages = path.join(await stateDir(root), "lineages", NONCE);
    await fs.mkdir(lineages, { recursive: true });
    await fs.writeFile(path.join(lineages, `${HASH}.db-wal`), "");
    expect(await hasResetLineageProvenance(root)).toBe(false);
  });

  test("E7b inventory is not JSON genesis eligibility and its residue survives", async () => {
    const root = await workspace();
    const residue = path.join(await stateDir(root), "reset-candidates", ".rbox-tmp-1-1-inert.db");
    await fs.mkdir(path.dirname(residue), { recursive: true });
    await fs.writeFile(residue, "inert reset residue\n");
    expect((await inventoryResetNamespace(root)).inertTemps).toEqual([residue]);
    await resetSyncState(root, "next-stream");
    expect((await loadState(root, "next-stream")).stream).toBe("next-stream");
    expect(await fs.readFile(residue, "utf8")).toBe("inert reset residue\n");
  });
});
