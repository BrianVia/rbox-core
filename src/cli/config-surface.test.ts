import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import * as config from "./config.js";

const expectedRuntimeExports = [
  "DEFERRAL_LANES",
  "MAX_LEGACY_GIT_SIDECAR_REPOS",
  "RBOX_DIR",
  "StreamMismatchError",
  "WorkspaceConfigNotFoundError",
  "applyStateSavePacket",
  "ensureCapableStateLineage",
  "ensureTelemetryBindingId",
  "expectedStateNonce",
  "findRoot",
  "loadConfig",
  "loadConfigIfPresent",
  "loadRawState",
  "loadState",
  "manifestFromMeta",
  "repoRecordsForState",
  "resetSyncState",
  "saveConfig",
  "saveState",
  "saveStateUnsafeLegacyOrTest",
  "stateFromRepoRecords",
  "stateLockPath",
  "statePath",
  "stateWasStreamMismatch",
  "syncStreamId",
  "trashConfig",
  "validManifestMeta",
];

const ownerFiles = [
  "workspace-config.ts",
  "sync-state-model.ts",
  "sync-state-store.ts",
  "reset-state.ts",
] as const;

test("config preserves its exact runtime compatibility surface", () => {
  expect(Object.keys(config).sort()).toEqual(expectedRuntimeExports);
});

test("config remains an explicit logic-free facade", async () => {
  const source = await fs.readFile(new URL("./config.ts", import.meta.url), "utf8");
  expect(source).not.toContain("export *");
  expect(source).not.toMatch(/\b(?:async\s+)?function\b|\bclass\b|=>/);
  expect(source.split("\n").filter((line) => line.trim() !== "").every(
    (line) => line.startsWith("export ") || line.startsWith("  ") || line.startsWith("} from "),
  )).toBe(true);
});

test("owner modules never enter a cycle or reach the compatibility facade", async () => {
  const srcRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const productionFiles = (await Array.fromAsync(fs.glob("**/*.ts", { cwd: srcRoot })))
    .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".typecheck.ts"))
    .map((file) => path.join(srcRoot, file));
  const productionSet = new Set(productionFiles);
  const graph = new Map<string, string[]>();

  for (const file of productionFiles) {
    const source = await fs.readFile(file, "utf8");
    const dependencies = [...source.matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/g)]
      .map((match) => path.resolve(path.dirname(file), match[1]!.replace(/\.js$/, ".ts")))
      .filter((dependency) => productionSet.has(dependency));
    graph.set(file, dependencies);
  }

  const cliRoot = path.dirname(new URL(import.meta.url).pathname);
  const roots = ownerFiles.map((file) => path.join(cliRoot, file));
  const reachable = new Set<string>();
  const collect = (file: string): void => {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const dependency of graph.get(file) ?? []) collect(dependency);
  };
  for (const root of roots) collect(root);

  const facade = path.join(cliRoot, "config.ts");
  expect(reachable.has(facade)).toBe(false);

  const reaches = (start: string, target: string): boolean => {
    const pending = [start];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (file === target) return true;
      if (seen.has(file)) continue;
      seen.add(file);
      pending.push(...(graph.get(file) ?? []));
    }
    return false;
  };
  for (const root of roots) {
    for (const dependency of graph.get(root) ?? []) {
      expect(reaches(dependency, root), `${path.basename(root)} participates in an import cycle`).toBe(false);
    }
  }
});
