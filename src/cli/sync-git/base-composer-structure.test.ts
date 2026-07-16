import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveState, type SyncState } from "../config.js";

const root = path.resolve(import.meta.dir, "../../..");
const srcRoot = path.join(root, "src");

interface Site {
  file: string;
  line: number;
  kind?: string;
  owner?: string;
}

interface AstSite extends Site {
  category: "call" | "property-assignment" | "property-write" | "property-delete";
  callee?: string;
  arguments?: string[];
  name?: string;
}

let astSites: AstSite[] | undefined;
function parsedAstSites(): AstSite[] {
  if (astSites) return astSites;
  const result = Bun.spawnSync([
    "node",
    path.join(import.meta.dir, "base-composer-ast-sweep.mjs"),
    root,
  ]);
  if (!result.success) throw new Error(result.stderr.toString() || `AST sweep exited ${result.exitCode}`);
  astSites = JSON.parse(result.stdout.toString()) as AstSite[];
  return astSites;
}

async function astSweep(match: (site: AstSite) => boolean): Promise<Site[]> {
  return parsedAstSites().filter(match);
}

async function productionSources(dir = srcRoot): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return productionSources(absolute);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name.endsWith(".bench-helper.ts")) return [];
    return [absolute];
  }));
  return files.flat().sort();
}

function counts(sites: readonly Site[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const site of sites) {
    result[site.file] = (result[site.file] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

/** Line-token sweep rather than substring presence checks. Every matching token
 * is counted against a closed file allowlist; adding a site, even in an already
 * allowlisted file, changes the count and fails the gate. */
async function sweep(pattern: RegExp, include: (file: string, line: string) => boolean = () => true): Promise<Site[]> {
  const sites: Site[] = [];
  for (const file of await productionSources()) {
    const lines = (await fs.readFile(file, "utf8")).split("\n");
    for (let line = 0; line < lines.length; line++) {
      const text = lines[line]!;
      if (!include(file, text)) continue;
      pattern.lastIndex = 0;
      const matches = text.match(pattern);
      for (let occurrence = 0; occurrence < (matches?.length ?? 0); occurrence++) {
        sites.push({ file: path.relative(root, file), line: line + 1 });
      }
    }
  }
  return sites;
}

test("design 130 whole-state persistence is a closed allowlist", async () => {
  const sites = await astSweep((site) => site.category === "call" && (
    ["saveState", "saveStateUnsafeLegacyOrTest"].includes(site.callee ?? "")
      || (["writeFileAtomic", "fs.writeFile"].includes(site.callee ?? "")
        && site.arguments?.[0]?.startsWith("statePath(") === true)
  ));
  expect(counts(sites)).toEqual({
    "src/cli/config.ts": 4,
    "src/cli/scan-probe.ts": 1,
    "src/cli/sync-state.ts": 4,
  });
});

test("design 130 raw whole-state APIs cannot be aliased into new production sites", async () => {
  const unsafe = await sweep(/\bsaveStateUnsafeLegacyOrTest\b/g);
  expect(counts(unsafe)).toEqual({
    "src/cli/config.ts": 1,
    "src/cli/sync-state.ts": 5,
  });
  const guarded = await sweep(/\bsaveState\b/g);
  expect(counts(guarded)).toEqual({ "src/cli/config.ts": 3 });
});

test("design 130 raw update-ref command sites are a closed allowlist", async () => {
  const sites = await astSweep((site) => site.category === "call"
    && ["git", "gitRaw", "spawn"].includes(site.callee ?? "")
    && site.arguments?.some((argument) => argument.includes("update-ref")) === true);
  expect(counts(sites)).toEqual({
    "src/cli/reset-journal.ts": 2,
    "src/cli/sync-git/follow.ts": 1,
    "src/cli/sync-git/orig-head.ts": 1,
    "src/engine/git/apply.ts": 3,
    "src/engine/git/base-artifacts.ts": 1,
    "src/engine/git/checkout-txn.ts": 1,
    "src/engine/git/journal.ts": 2,
    "src/engine/git/keep-pins.ts": 2,
    "src/engine/git/pins.ts": 4,
    "src/engine/git/quarantine.ts": 3,
    "src/engine/git/rollback.ts": 4,
  });
});

test("design 130 persisted BASE and branch-origin writes are a closed allowlist", async () => {
  const sites = await astSweep((site) => site.file.startsWith("src/cli/")
    && ["base", "branchBaseOrigins"].includes(site.name ?? ""));
  expect(counts(sites)).toEqual({
    "src/cli/config.ts": 19,
    "src/cli/git-cmd.ts": 8,
    "src/cli/sync-git/apply.ts": 21,
    "src/cli/sync-git/base-composer.ts": 2,
    "src/cli/sync-git/follow.ts": 1,
    "src/cli/sync-git/p-repair-state.ts": 1,
    "src/cli/sync-git/p-settlement.ts": 1,
    "src/cli/sync-state.ts": 14,
    "src/cli/sync/pull.ts": 2,
  });
});

test("saveState rejects Git state outside the explicit legacy/test escape hatch", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-save-state-guard-"));
  const gitState: SyncState = {
    stream: "guard",
    lastSyncedSequence: 1,
    lastSyncedManifest: {
      generatedAt: "now",
      files: [],
      gitRepos: { repo: { refs: {}, head: null, refScope: "all" } },
    },
  };
  await expect(saveState(temp, gitState)).rejects.toThrow(/refuses Git BASE or repository records/);
});

test("design 130 authority switch is exhaustive over the closed union", async () => {
  const composer = await fs.readFile(path.join(root, "src/cli/sync-git/base-composer.ts"), "utf8");
  for (const kind of [
    "pull-ref-transaction", "pull-carry", "journal-recovery", "publisher-ack", "manual", "p-repair", "migration",
  ]) expect(composer).toContain(`case "${kind}"`);
  expect(composer).toContain("const neverAuthority: never = authority");
});
