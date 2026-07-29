/**
 * The duplicate-declaration gate.
 *
 * Two lanes working in parallel keep independently declaring the same symbol in
 * different modules, and nothing in the toolchain notices. `git merge-tree`
 * reports no conflict, because the declarations are in different files (or at
 * different offsets in one file). `tsc` reports nothing either: two modules may
 * each declare `interface Foo`, and if the two shapes are structurally
 * compatible every assignment between them still typechecks. The failure
 * surfaces much later — when the owning module brands its type to make it
 * unforgeable, and the private copy silently stays forgeable.
 *
 * So the property pinned here is textual, not semantic: one exported name is
 * declared in one module. A collision is either a mistake to fix by importing
 * from the owner, or a deliberate coincidence that belongs in ALLOWED with a
 * reason a reviewer can check.
 *
 * Scope is `src/` — the same scope as the sole-writer gate in
 * `migration/control.test.ts`. `src/` is what links into the one CLI binary, so
 * a name declared twice here is two live declarations in one program. `apps/`
 * builds separately deployed surfaces with their own tsconfigs (a name shared
 * between the worker and the CLI is not a collision), and `scripts/` is one-shot
 * tooling that no binary links.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dir, "../../..", "src");

/** Top-level exported declarations. TypeScript puts these at column 0, so the
 * line anchor is what makes a plain scan exact: nothing nested, and nothing
 * inside a string or comment, begins a line with `export <kind> <name>`. */
const DECLARATION = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|type|function|const|let|enum)\s+(?:\*\s*)?([A-Za-z_$][\w$]*)/gm;

/** `export type A = B;` and `export const A = b;` — a seam re-exporting one
 * thing under a local name. It declares no second shape, so it cannot drift
 * from the original the way a re-typed copy can. */
const REEXPORT_ALIAS = /^export\s+(?:type|const)\s+[A-Za-z_$][\w$]*\s*=\s*[A-Za-z_$][\w$.]*\s*;/;

interface Declaration {
  name: string;
  kind: string;
  file: string;
  line: number;
}

/** Collisions that are not mistakes. Every entry needs a reason, because
 * "these are unrelated" is a claim the next reader has to be able to check.
 *
 * `sites` is the exact number of declarations excused. Pinning it is what keeps
 * an excuse from growing: a THIRD module declaring an already-excused name is
 * the very defect this gate exists to catch, and a bare name would wave it
 * through. */
const ALLOWED: ReadonlyMap<string, { sites: number; reason: string }> = new Map([
  ["AdmissionProof", { sites: 2, reason: "unrelated domains: an e2ee roster admission signature bundle vs. design 163's migration byte budget" }],
  ["DeferralDiscoveryAuthority", { sites: 2, reason: "REAL DUPLICATE, pending removal — the same two fields in daemon/git-discovery-continuity.ts and sync-git/deferral-hygiene.ts, differing only in `readonly`. Pick an owner, import it, delete this entry" }],
  ["HeadPin", { sites: 2, reason: "REAL DUPLICATE, pending removal — byte-identical interface in e2ee-keystore.ts and e2ee-remote-types.ts. Pick an owner, import it, delete this entry" }],
  ["GIT_DEFERRAL_REASONS", { sites: 2, reason: "telemetry/contract.ts deliberately restates the wire list; its `satisfies` plus exhaustiveness assert make any drift from sync-state-model.ts a type error" }],
  ["LineageSnapshot", { sites: 3, reason: "three unrelated snapshots that happen to share a word: a daemon observation pair, the state-plane port row, and the git-capture sidecar binding" }],
  ["Manifest", { sites: 2, reason: "unrelated domains: the signed release manifest vs. the synced file-tree manifest" }],
  ["PhysicalProof", { sites: 2, reason: "REAL DUPLICATE, pending removal — artifact-proof.ts declares the identical interface at lines 24 and 66; TypeScript merges them silently. Delete the second one; this entry goes with it" }],
  ["ResetConsentKind", { sites: 2, reason: "REAL DUPLICATE, pending removal — the identical two-member union in reset-consent.ts and reset-journal-schema.ts. Pick an owner, import it, delete this entry" }],
  ["ResetJournal", { sites: 2, reason: "reset-journal-legacy-schema.ts and reset-journal-schema.ts are a deliberate legacy/current schema pair, versioned in lockstep" }],
  ["ResetJournalV1", { sites: 2, reason: "same deliberate legacy/current schema pair as ResetJournal" }],
  ["SyncState", { sites: 2, reason: "telemetry/contract.ts is the wire projection of the model in sync-state-model.ts, intentionally a separate narrower shape" }],
  ["WorkspaceChoice", { sites: 2, reason: "unrelated domains: init-plan's new/join command union vs. the picker's list-row label/value" }],
  ["boundedStream", { sites: 2, reason: "unrelated: sealed-stages batches rows under a byte budget, reset-io reads a file under a byte cap" }],
  ["doctorCmd", { sites: 2, reason: "REAL DUPLICATE, pending rename — hydrate-cmd.ts exports an unrelated hydrate routine under the doctor command's name. Rename it; this entry goes with it" }],
  ["ensureTelemetryBindingId", { sites: 2, reason: "the legacy-JSON and SQLite planes each implement this write for their own store during U3; they converge when the legacy adapter retires" }],
  ["fsyncDirectory", { sites: 2, reason: "the state-plane store is synchronous by construction (descriptor-bound proofs), so it cannot use engine/fsutil's promise-returning one" }],
  ["errCode", { sites: 2, reason: "unrelated: engine/fsutil returns `string | undefined` for absent-code handling, daemon/logger returns a always-present `\"unknown\"` fallback for log lines" }],
  ["genesisPaths", { sites: 2, reason: "unrelated domains: state-plane genesis artifacts keyed by workspace root vs. e2ee enrollment artifacts keyed by account id" }],
  ["promptWorkspacePick", { sites: 3, reason: "TypeScript call overloads — three signatures, one implementation" }],
]);

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".ts")) continue;
    // Tests and their helpers legitimately restate fixture shapes; `.d.ts` files
    // are ambient declarations, not modules.
    if (entry.endsWith(".test.ts") || entry.endsWith(".test-helper.ts") || entry.endsWith(".d.ts")) continue;
    files.push(entry.split(path.sep).join("/"));
  }
  return files.sort();
}

function declarations(): Declaration[] {
  const found: Declaration[] = [];
  for (const relative of sourceFiles()) {
    const text = fs.readFileSync(path.join(SRC, relative), "utf8");
    const lines = text.split("\n");
    for (const match of text.matchAll(DECLARATION)) {
      const line = text.slice(0, match.index).split("\n").length;
      if (REEXPORT_ALIAS.test(lines[line - 1] ?? "")) continue;
      found.push({ name: match[2]!, kind: match[1]!, file: `src/${relative}`, line });
    }
  }
  return found;
}

function site(declaration: Declaration): string {
  return `${declaration.file}:${declaration.line} (${declaration.kind})`;
}

function offenders(): string[] {
  const byName = new Map<string, Declaration[]>();
  for (const declaration of declarations()) {
    const existing = byName.get(declaration.name);
    if (existing) existing.push(declaration);
    else byName.set(declaration.name, [declaration]);
  }

  const reported: string[] = [];
  for (const [name, all] of [...byName].sort()) {
    if (all.length < 2 || ALLOWED.get(name)?.sites === all.length) continue;

    const files = new Set(all.map((declaration) => declaration.file));
    // Within one file, only a repeat of the SAME kind is a re-declaration.
    // `export const EOF` beside `export type EOF` is one symbol in the value and
    // type namespaces, and repeated `export function` is a call overload.
    const sameKindRepeat = files.size === 1
      && all.some((left, index) => all.some((right, other) =>
        other > index && right.kind === left.kind && left.kind !== "function"));
    if (files.size < 2 && !sameKindRepeat) continue;

    const excused = ALLOWED.get(name);
    reported.push(
      `${name} is declared in more than one place: ${all.map(site).join(", ")}`
      + " — import it from the owner instead of re-declaring it"
      + (excused
        ? `. ALLOWED excuses only ${excused.sites} of these ${all.length} declarations (${excused.reason});`
          + " a further copy is exactly the defect this gate catches."
        : " (or add it to ALLOWED with a reason, if the collision is deliberate)."),
    );
  }
  return reported;
}

/**
 * Durable filenames under `.rbox`. A module cannot write a record it cannot
 * name, so re-typing one of these names is how a second writer of a
 * single-writer record gets created — the same defect the sole-writer gate in
 * `migration/control.test.ts` pins for the migration control, generalized to
 * every durable record `paths.ts` owns.
 *
 * `state.db` is deliberately absent: it is a stem rather than a filename
 * (`state.db.migrate.<id>`, `state.db.genesis.<id>`), so the sites that name it
 * are not the single-writer shape this gate is about.
 */
const OWNER = "src/cli/state-plane/paths.ts";
const DURABLE_FILENAMES: readonly string[] = [
  "state.json", "state-incarnation.json", "reset-v1.json", "migration-v1.json",
  "genesis-v1.json", "reserve-1mib.bin", "pre-163-latest.json.bak",
];

/** Files that may still spell a durable name themselves. Each needs a reason. */
const LITERAL_ALLOWED: ReadonlyMap<string, string> = new Map([
  ["src/cli/doctor-state-plane.ts", "reports on the legacy authority document by name without reading it through the path policy"],
  ["src/cli/reset-journal.ts", "the pre-163 reset journal owns its own legacy path constructors (`activeStatePath`, `resetJournalPath`, `resetIncarnationPath`)"],
  ["src/cli/reset-journal-doctor.ts", "diagnoses the pre-163 layout directly, by design"],
  ["src/cli/reset-quarantine.ts", "chooses between the legacy and SQLite layouts before either path policy applies"],
  ["src/cli/state-plane/errors.ts", "StreamMismatchError renders the stable legacy paths in user-facing copy; it never reads or writes them (already exempt in inventory.test.ts)"],
  ["src/cli/state-plane/migration/reserve.ts", "pre-dates paths.migrationPaths.reserve; collapsing it is a separate change"],
  ["src/cli/state-plane/reset/crash-rig-child.ts", "a spawned crash-rig fixture that must name the on-disk layout literally to be a faithful witness"],
]);

/** JSDoc and line comments mention these names constantly; only code counts. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .join("\n");
}

describe("duplicate declarations", () => {
  test("no exported name is declared by two modules", () => {
    expect(declarations().length, "the declaration scan found nothing — it is broken, not clean")
      .toBeGreaterThan(500);
    expect(offenders()).toEqual([]);
  });

  test("only paths.ts names a durable .rbox record", () => {
    const found: string[] = [];
    for (const relative of sourceFiles()) {
      const file = `src/${relative}`;
      if (file === OWNER || LITERAL_ALLOWED.has(file)) continue;
      const code = withoutComments(fs.readFileSync(path.join(SRC, relative), "utf8"));
      for (const name of DURABLE_FILENAMES) {
        if (new RegExp(`["'\`]${name.replace(/\./g, "\\.")}`).test(code)) {
          found.push(
            `${file} spells the durable filename "${name}", which ${OWNER} owns`
            + " — import it from the owner instead of re-declaring it.",
          );
        }
      }
    }
    expect(found).toEqual([]);
  });

  test("every allowlist entry states a reason", () => {
    for (const [name, { reason }] of ALLOWED) expect(reason.length, name).toBeGreaterThan(30);
    for (const [file, reason] of LITERAL_ALLOWED) expect(reason.length, file).toBeGreaterThan(30);
  });

  test("no allowlist entry outlives the collision it excuses", () => {
    const counts = new Map<string, number>();
    for (const { name } of declarations()) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const [name, { sites }] of ALLOWED) {
      expect(counts.get(name) ?? 0, `ALLOWED excuses ${sites} declarations of ${name}; the tree no longer has that many`)
        .toBe(sites);
    }
    for (const file of LITERAL_ALLOWED.keys()) {
      expect(fs.existsSync(path.resolve(SRC, "..", file)), `LITERAL_ALLOWED still excuses ${file}, which no longer exists`)
        .toBeTrue();
    }
  });
});
