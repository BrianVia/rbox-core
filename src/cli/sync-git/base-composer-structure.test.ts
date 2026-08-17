import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveState, type SyncState } from "../config.js";
import { runAstSweep, type AstSweepDeps } from "./ast-sweep-runner.js";

const root = path.resolve(import.meta.dir, "../../..");
const srcRoot = path.join(root, "src");
// 11,768 bytes when introduced; leave room for legitimate allowlist growth.
const AST_SWEEP_MAX_BYTES = 20 * 1024;

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
  const result = runAstSweep(
    path.join(import.meta.dir, "base-composer-ast-sweep.mjs"),
    root,
    "base-composer-structure",
  );
  expect(result.stdoutLength, "AST sweep returned empty stdout").toBeGreaterThan(0);
  expect(result.stdoutLength, "AST sweep output exceeded its transport budget")
    .toBeLessThanOrEqual(AST_SWEEP_MAX_BYTES);
  const parsed = result.parsed;
  expect(Array.isArray(parsed), "AST sweep output was not an array").toBeTrue();
  expect(parsed.length, "AST sweep returned no records").toBeGreaterThan(0);
  astSites = parsed as AstSite[];
  return astSites;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test("AST sweep retries unusable stdout through explicit piped stdio", () => {
  const attempts = [
    { success: true, exitCode: 0, stdout: bytes(""), stderr: bytes("") },
    { success: true, exitCode: 0, stdout: bytes("{]"), stderr: bytes("parse noise") },
    { success: true, exitCode: 0, stdout: bytes('[{"file":"ok","line":1}]'), stderr: bytes("") },
  ];
  const options: unknown[] = [];
  const backoffs: number[] = [];
  const deps: AstSweepDeps = {
    spawn: (_command, stdio) => {
      options.push(stdio);
      return attempts.shift()!;
    },
    sleep: (milliseconds) => backoffs.push(milliseconds),
  };

  const result = runAstSweep("/sweep.mjs", "/repo", "base-composer-structure", deps);

  expect(result.parsed).toEqual([{ file: "ok", line: 1 }]);
  expect(options).toEqual([
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  ]);
  expect(backoffs).toEqual([10, 20]);
});

test("AST sweep reports the final child diagnostic after exhausting retries", () => {
  const backoffs: number[] = [];
  const deps: AstSweepDeps = {
    spawn: () => ({
      success: false,
      exitCode: 23,
      stdout: bytes("bad"),
      stderr: bytes("distinctive child failure"),
    }),
    sleep: (milliseconds) => backoffs.push(milliseconds),
  };

  expect(() => runAstSweep("/sweep.mjs", "/repo", "state-plane-inventory", deps)).toThrow(
    /failed after 3 attempts.*child exit code 23.*stderr: distinctive child failure.*stdout length 3 bytes/,
  );
  expect(backoffs).toEqual([10, 20]);
});

async function astSweep(match: (site: AstSite) => boolean): Promise<Site[]> {
  return parsedAstSites().filter(match);
}

async function productionSources(dir = srcRoot): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return productionSources(absolute);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")
      || entry.name.endsWith(".typecheck.ts") || entry.name.endsWith(".bench-helper.ts")) return [];
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
  // `publishWholeState` is design 163 B0's single barrier-checked publication
  // seam; it counts as a whole-state persistence site so routing through it can
  // never be used to slip past this gate.
  const sites = await astSweep((site) => site.category === "call" && (
    ["saveState", "saveStateUnsafeLegacyOrTest", "publishWholeState"].includes(site.callee ?? "")
      || (["writeFileAtomic", "fs.writeFile"].includes(site.callee ?? "")
        && site.arguments?.[0]?.startsWith("statePath(") === true)
  ));
  expect(counts(sites)).toEqual({
    "src/cli/scan-probe.ts": 1,
    "src/cli/state-plane/adapters/legacy-json-store.ts": 4,
    "src/cli/state-plane/adapters/whole-state-compat.ts": 1,
    "src/cli/sync-state.ts": 1,
  });
});

test("design 130 raw whole-state APIs cannot be aliased into new production sites", async () => {
  // The compatibility facades are separately pinned by config-surface.test.ts:
  // `config.ts` and the `sync-state-store.ts` re-export facade both name these
  // APIs only to forward them. This closed set counts the owner definition and
  // production consumers, so decomposition cannot inflate the pre/post
  // operation-category total.
  const outsideFacade = (file: string): boolean =>
    file !== path.join(srcRoot, "cli", "config.ts")
    && file !== path.join(srcRoot, "cli", "sync-state-store.ts");
  const unsafe = await sweep(/\bsaveStateUnsafeLegacyOrTest\b/g, outsideFacade);
  expect(counts(unsafe)).toEqual({
    "src/cli/state-plane/adapters/legacy-json-store.ts": 1,
    "src/cli/state-plane/adapters/whole-state-compat.ts": 2,
    "src/cli/sync-state.ts": 2,
  });
  const guarded = await sweep(/\bsaveState\b/g, outsideFacade);
  expect(counts(guarded)).toEqual({
    "src/cli/state-plane/adapters/legacy-json-store.ts": 2,
  });
});

test("design 130 raw update-ref command sites are a closed allowlist", async () => {
  const sites = await astSweep((site) => site.category === "call"
    && ["git", "gitRaw", "spawn"].includes(site.callee ?? "")
    && site.arguments?.some((argument) => argument.includes("update-ref")) === true);
  expect(counts(sites)).toEqual({
    "src/cli/adopt-git.ts": 1,
    "src/cli/reset-z-runtime.ts": 3,
    "src/cli/state-plane/reset/crash-rig-child.ts": 1,
    // Was sync-git/follow.ts; the same single site moved with stageIncoming
    // when follow.ts was split into domain modules. Count unchanged.
    "src/cli/sync-git/follow-staging.ts": 1,
    "src/cli/sync-git/orig-head.ts": 1,
    "src/cli/sync-git/git-state-apply.ts": 3,
    "src/cli/sync-git/base-artifacts.ts": 1,
    "src/cli/sync-git/checkout-txn.ts": 1,
    "src/cli/sync-git/keep-pins.ts": 2,
    "src/cli/sync-git/pins.ts": 1,
    "src/cli/sync-git/quarantine.ts": 3,
    "src/cli/sync-git/rollback.ts": 4,
    "src/cli/sync-git/v1724-journal-fixture.test-helper.ts": 1,
  });
});

test("design 130 persisted BASE and branch-origin writes are a closed allowlist", async () => {
  const sites = await astSweep((site) => site.file.startsWith("src/cli/")
    && ["base", "branchBaseOrigins"].includes(site.name ?? ""));
  expect(counts(sites)).toEqual({
    // Design 177 retains read-only oracle proof inputs named `base`; BASE writes
    // still route only through the composer/state transitions guarded below.
    "src/cli/git/resolve-command.ts": 9,
    // U1a's unwired SQLite codec exhaustively maps the existing RepoRecord
    // shape; it has no authority-write call site.
    "src/cli/state-plane/codecs/coverage.ts": 2,
    "src/cli/state-plane/codecs/repo-record.ts": 2,
    // Blanket migration authority and the legacy-manifest adoption it exists
    // for. Confined here so no ordinary write path can default to it; the
    // importer set is pinned by sync-git/base-proof-authority.test.ts.
    "src/cli/state-plane/migration/base-proof.ts": 3,
    // U1b's unwired CAS recomposes BASE exactly like the JSON authority: one
    // composeRepoBase call per transition, driven by that transition's own
    // explicit RepoBaseProof. Step 2 lives in exactly one module, so there is no
    // second BASE-writing path in the store, and a proofless row never reaches an
    // authority write (ProoflessBaseError) — including branch-origin-only removal.
    "src/cli/state-plane/store/cas-steps.ts": 8,
    // 24 before the held-decision decomposition: the follow path repeated one
    // identical base composition four times. It is built once now
    // (`followComposition`), so three copies of its three sites are gone.
    "src/cli/sync-git/apply.ts": 15,
    "src/cli/sync-git/base-composer.ts": 2,
    // Was sync-git/follow.ts; the same single read-only site moved with
    // classifyCheckout when follow.ts was split. Count unchanged.
    "src/cli/sync-git/follow-classify.ts": 1,
    "src/cli/sync-git/p-repair-state.ts": 1,
    "src/cli/sync-git/p-settlement.ts": 1,
    // The unreadable-terminal carry moved with its owner again: design 271 gave
    // both of a commit's withdrawals one module. The allowlist follows
    // ownership, so the count moved rather than grew.
    "src/cli/sync-git/committed-transition-withdrawal.ts": 1,
    // Design 178 D.3 read-only publisher-ACK composer dry-run inputs/result.
    "src/cli/sync-git/pending-supersession.ts": 3,
    "src/cli/sync-git/plan-accumulator.ts": 1,
    "src/cli/sync-git/plan.ts": 3,
    // Persistence sanitation only: the one owner that rewrites a record's stored
    // BASE/pending into their sanitized form. It composes no authority and moves
    // no lineage — it replaces the section it was handed with its canonical
    // bytes, the write sync-state.ts and legacy-json-store.ts each open-coded
    // before it was extracted.
    "src/cli/repo-record-sanitation.ts": 1,
    // The record projection kept the legacy-manifest adoption it belonged to
    // when design 269 split it out of the model file; count-neutral.
    "src/cli/sync-state-records.ts": 8,
    // T1.1 moved the JSON CAS here; the proof-selection hoist is count-neutral.
    "src/cli/state-plane/adapters/legacy-json-store.ts": 8,
    // 14 in sync-state.ts before design 269 split the published-intent
    // completion into its own owner; the 22 sites are unchanged.
    "src/cli/sync-published-intent.ts": 8,
    "src/cli/sync-state.ts": 6,
    // 2 in sync/pull.ts before design 267 moved the pull's state-save into its
    // own owner: the two sites were one `bases:` literal written twice, once for
    // observedRepos and once for values. The save composes it once now.
    "src/cli/sync/pull-state-save.ts": 1,
  });
});

test("design 200 publisher ACK derives identity, advertised refs, and effective scope from one accepted section", async () => {
  // The sole constructor moved with its owner (AcknowledgePublishedGitTransitions);
  // the allowlist follows ownership and is never widened to both files.
  const source = await fs.readFile(path.join(srcRoot, "cli", "sync", "publisher-ack-transition.ts"), "utf8");
  const constructor = source.match(
    /const section = committed\.gitRepos\?\.\[relPath\];[\s\S]*?kind: "publisher-ack",[\s\S]*?incomingKey: gitIncomingKey\(section\),[\s\S]*?advertisedRefs: section\.refs,[\s\S]*?effectiveRefScope: section\.refScope,/,
  );
  expect(constructor).not.toBeNull();
  expect(source.match(/kind: "publisher-ack"/g)).toHaveLength(1);
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
