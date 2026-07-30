/**
 * The replay child: drive the real 2.0 authority machine against the COPY.
 *
 * Since wave 5B it drives the REAL entry point: `migrateCmd`, exactly as
 * `rbox migrate` does, capturing the lines a user would have read. It used to
 * mirror the composition an entry site would perform; mirroring is what lets a
 * harness pass while the shipped command is broken, and the command now exists.
 *
 * Isolation is the parent's job (env + strace), but this child refuses to run
 * at all unless `HOME`/`RBOX_HOME` and the workspace root are inside the
 * sandbox it was handed. A harness that could silently point at `~/.rbox` is
 * worth less than no harness.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SyncState } from "../../src/cli/sync-state-model.js";
import { normalizeLegacyStateV1 } from "../../src/cli/state-plane/digest/legacy-state-plan.js";
import { legacyStateSemanticDigest, stateSemanticDigest } from "../../src/cli/state-plane/digest/state-semantic-v1.js";
import { classifyStateFormat } from "../../src/cli/state-plane/authority-marker.js";
import { migrateCmd } from "../../src/cli/state-plane-cmd.js";
import { withStatePlaneLocks, type HeldStatePlaneLocks } from "../../src/cli/state-plane/locks.js";
import { sqliteResetPaths, statePath } from "../../src/cli/state-plane/paths.js";
import { classifyMigrationState } from "../../src/cli/state-plane/migration/classifier.js";
import { readCanonicalControl } from "../../src/cli/state-plane/migration/control-publication.js";
import { readCompletionTuple } from "../../src/cli/state-plane/migration/import-install.js";
import { openStateStore, stateStoreDatabase } from "../../src/cli/state-plane/store/open.js";
import { sandboxLayout } from "./layout.js";

function argOf(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`missing ${flag}`);
  return path.resolve(value);
}

const layout = sandboxLayout(argOf("--sandbox"));
const inside = (value: string | undefined): boolean =>
  value !== undefined && (value === layout.root || value.startsWith(`${layout.root}${path.sep}`));
for (const [name, value] of [["HOME", process.env.HOME], ["RBOX_HOME", process.env.RBOX_HOME]] as const) {
  if (!inside(value)) throw new Error(`refusing to replay: ${name}=${String(value)} is outside ${layout.root}`);
}
if (!inside(layout.ws)) throw new Error("refusing to replay: the workspace root is outside the sandbox");

const root = layout.ws;
const startedAt = Date.now();

/** Everything the command printed, in order, plus its exit code — which is the
 * whole contract a script or the rig has with it. */
const migrateLines: string[] = [];
const exitCode = await migrateCmd(root, { log: (line) => migrateLines.push(line) });
const elapsedMs = Date.now() - startedAt;

/** The same command again on the workspace it just converted. Before wave 5B
 * this threw `StateFormatTooNewError` out of the lock bundle's inventory, so
 * `rbox migrate` could not report success on its own work. */
const secondLines: string[] = [];
const secondExitCode = await migrateCmd(root, { log: (line) => secondLines.push(line) });

/**
 * Post-Q re-entry, observed rather than assumed. Wave 5B routed the inventory
 * through the selecting whole-state seam, so a second bundle is now expected to
 * be HELD after a successful migration. This probe is what says whether it is.
 */
async function probeReentry(): Promise<string> {
  try {
    const outcome = await withStatePlaneLocks(root, async () => "held");
    return outcome.held ? "held" : `refused: ${outcome.refusal.code}`;
  } catch (error) {
    return `threw: ${error instanceof Error ? error.constructor.name : String(error)}`;
  }
}

interface Verdict { readonly check: string; readonly ok: boolean; readonly detail: string }

function checkRows(db: ReturnType<typeof stateStoreDatabase>, pragma: string): Array<Record<string, unknown>> {
  const prepared = db.prepare(pragma);
  try {
    return prepared.all() as Array<Record<string, unknown>>;
  } finally {
    prepared.finalize();
  }
}

/**
 * Fidelity against the PRISTINE legacy document, not against the one the
 * migration read: M6 deletes the source, so the only way to re-derive the
 * expected digest afterwards is the copy the snapshot set aside.
 *
 * The lineage id is read back out of the store rather than recomputed, so the
 * harness carries no second copy of `importLineageId`'s formula. What pins the
 * import to the real source is the pair of provenance facts beside it: the
 * completion row's `sourceJsonSha256` must be the pristine bytes' hash, and its
 * counts must be the plan's.
 */
function verifyFidelity(verdicts: Verdict[]): void {
  const file = sqliteResetPaths.active(root);
  const store = openStateStore(file, { readonly: true });
  try {
    const db = stateStoreDatabase(store);
    const integrity = checkRows(db, "PRAGMA integrity_check");
    verdicts.push({
      check: "integrity_check",
      ok: integrity.length === 1 && Object.values(integrity[0]!)[0] === "ok",
      detail: JSON.stringify(integrity).slice(0, 200),
    });
    const violations = checkRows(db, "PRAGMA foreign_key_check");
    verdicts.push({
      check: "foreign_key_check", ok: violations.length === 0, detail: `${violations.length} violations`,
    });

    const completion = readCompletionTuple(db);
    const lineage = checkRows(db, "SELECT lineage_id FROM state_lineage");
    const lineageId = String(lineage[0]?.lineage_id ?? "");
    const bytes = fs.readFileSync(layout.pristineState);
    const sourceSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const plan = normalizeLegacyStateV1(JSON.parse(bytes.toString("utf8")) as SyncState, lineageId);
    const expected = legacyStateSemanticDigest(plan);
    const live = stateSemanticDigest(db);

    verdicts.push({
      check: "source-json-sha256",
      ok: completion.sourceJsonSha256 === sourceSha256,
      detail: `completion ${completion.sourceJsonSha256} vs pristine ${sourceSha256}`,
    });
    verdicts.push({
      check: "semantic-digest-store-vs-legacy",
      ok: live === expected,
      detail: `store ${live} vs legacy ${expected}`,
    });
    verdicts.push({
      check: "semantic-digest-store-vs-completion",
      ok: live === completion.sourceSemanticDigest,
      detail: `store ${live} vs completion ${completion.sourceSemanticDigest}`,
    });
    verdicts.push({
      check: "entry-count",
      ok: completion.entryCount === plan.entries.length,
      detail: `completion ${completion.entryCount} vs plan ${plan.entries.length}`,
    });
    verdicts.push({
      check: "repo-count",
      ok: completion.repoCount === plan.repos.length,
      detail: `completion ${completion.repoCount} vs plan ${plan.repos.length}`,
    });
    verdicts.push({
      check: "source-bytes", ok: completion.sourceBytes === bytes.byteLength,
      detail: `completion ${completion.sourceBytes} vs pristine ${bytes.byteLength}`,
    });
    verdicts.push({
      check: "store-header-authority",
      ok: store.header.authority_id === completion.authorityId,
      detail: `${store.header.authority_id} vs ${completion.authorityId}`,
    });
  } finally {
    store.close();
  }
}

/**
 * When the run halts at M4, say WHICH of M4's checks refused.
 *
 * The halt taxonomy carries a code and no detail — `verification` covers five
 * distinct refusals in `prove-staging.ts`, and the message each one raises is
 * dropped before the outcome reaches a caller. So a halted run is re-checked
 * here against the staging database the migration left behind, which is the
 * difference between "M4 refused" and a nameable defect.
 *
 * `tupleValueEqual` is separated from `tupleStringEqual` deliberately: M4
 * compares the two completion tuples with `JSON.stringify`, and the control
 * record round-trips through JCS, which sorts keys.
 */
function m4Forensics(): Record<string, unknown> | null {
  const control = readCanonicalControl(root);
  if (!control || control.witness.phase !== "M3") return null;
  const witness = control.witness.completion;
  const store = openStateStore(control.stagingPath, { readonly: true });
  try {
    const db = stateStoreDatabase(store);
    const committed = readCompletionTuple(db);
    const keys = Object.keys(witness).sort();
    const integrity = checkRows(db, "PRAGMA integrity_check");
    return {
      authorityMatches: store.header.authority_id === control.authorityId,
      tupleStringEqual: JSON.stringify(committed) === JSON.stringify(witness),
      tupleValueEqual: JSON.stringify(committed, keys) === JSON.stringify(witness, keys),
      committedKeyOrder: Object.keys(committed),
      witnessKeyOrder: Object.keys(witness),
      semanticDigestMatches: stateSemanticDigest(db) === witness.sourceSemanticDigest,
      foreignKeyViolations: checkRows(db, "PRAGMA foreign_key_check").length,
      integrityCheck: integrity.length === 1 ? Object.values(integrity[0]!)[0] : integrity.length,
    };
  } finally {
    store.close();
  }
}

const verdicts: Verdict[] = [];
const format = await classifyStateFormat(statePath(root));
verdicts.push({ check: "state.json-is-authority-marker", ok: format === "authority-marker", detail: String(format) });
const reentry = await probeReentry();
// `classifyMigrationState` takes the lock bundle as a compile-time witness only
// (`void locks`), and no bundle is obtainable post-Q — see `probeReentry`.
const row = await classifyMigrationState(root, {} as unknown as HeldStatePlaneLocks);
verdicts.push({ check: "classifier-row", ok: row.row === "terminal-sqlite", detail: row.row });

let fidelityError: string | undefined;
if (format === "authority-marker") {
  try {
    verifyFidelity(verdicts);
  } catch (error) {
    fidelityError = error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
  }
} else {
  fidelityError = "skipped: the workspace did not reach SQLite authority";
}

const control = readCanonicalControl(root);
let forensics: Record<string, unknown> | null = null;
if (format !== "authority-marker") {
  try {
    forensics = m4Forensics();
  } catch (error) {
    forensics = { error: error instanceof Error ? error.message : String(error) };
  }
}
const report = {
  root,
  entryPoint: "rbox migrate (migrateCmd)",
  exitCode,
  migrateLines,
  secondExitCode,
  secondLines,
  elapsedMs,
  reentry,
  verdicts,
  fidelityError: fidelityError ?? null,
  m4Forensics: forensics,
  /** The durable control record as it was left, so a halt is reported with the
   * evidence rather than only its code. */
  control: control ? { phase: control.witness.phase, revision: control.controlRevision, halt: control.halt } : null,
  fidelity: fidelityError === undefined && verdicts.every((v) => v.ok) ? "pass" : "fail",
  /** The 5B acceptance condition: the real command converted the workspace AND
   * reported cleanly when run again on the result. */
  entryPointVerdict: exitCode === 0 && secondExitCode === 0 && reentry === "held" ? "pass" : "fail",
};
fs.writeFileSync(path.join(layout.probe, "replay.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
