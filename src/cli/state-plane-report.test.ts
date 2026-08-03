/**
 * The operator surface's words (design 222 §6, wave 5B).
 *
 * These are copy tests, and they earn their place by pinning the four wordings
 * the wave found WRONG rather than merely present:
 *
 *   1. `reserved-path` claimed rbox "found an unexpected file" on rows where
 *      there is no file at all.
 *   2. `measured()` rendered `source-oversize` backwards and leaked the literal
 *      string "unknown" into user text.
 *   3. `nothing-to-abort` did not exist as a distinct message, so a pristine
 *      workspace was told its records had been migrated.
 *   4. The halted-retirement detail named `rbox doctor`, which prints the halt
 *      again and changes nothing.
 *
 * Plus the two standing prohibitions, asserted across EVERY message rather than
 * on the rows that happen to be about backups.
 */
import { expect, test } from "bun:test";
import {
  GENESIS_REFUSAL_COPY, MIGRATION_DISPOSITION_COPY, MIGRATION_HALT_COPY,
  MIGRATION_REFUSAL_COPY, MIGRATION_STEP_COPY, type OperatorCopy,
} from "./state-plane-copy.js";
import {
  describeAdmissionRefusal, describeAuthorityCorruption, describeFormatTooNew,
  describeGenesisOutcome, describeLockRefusal, describeMigrationHalt, describeMigrationOutcome,
  describeWorkspaceBusy, operatorReportJson, renderOperatorReport, type OperatorReport,
} from "./state-plane-report.js";
import { RESET_MATERIALIZED_BYTE_LIMIT } from "./reset-io.js";
import type { MigrationHalt, MigrationHaltCode } from "./state-plane/migration/health.js";

const ROOT = "/tmp/rbox-report-fixture";

const halt = (
  code: MigrationHaltCode, fields: Partial<MigrationHalt> = {},
): MigrationHalt => ({ code, underlyingCode: null, required: null, available: null, ...fields });

/** Every message the surface can produce, without touching a filesystem: the
 * report module reads only the canonical control, and an absent one is the
 * ordinary case. */
function everyReport(): OperatorReport[] {
  const codes = Object.keys(MIGRATION_HALT_COPY) as MigrationHaltCode[];
  return [
    ...codes.map((code) => describeMigrationHalt(ROOT, halt(code, { required: 1024, available: 2048 }), true)),
    ...codes.map((code) => describeMigrationHalt(ROOT, halt(code), false)),
    describeMigrationOutcome(ROOT, { kind: "migrated", phases: ["M0", "M7"], elapsedMs: 44_000 }),
    describeMigrationOutcome(ROOT, { kind: "already-migrated" }),
    describeMigrationOutcome(ROOT, { kind: "nothing-to-abort" }),
    describeMigrationOutcome(ROOT, { kind: "retired", reason: "source-changed", fromPhase: "M3" }),
    describeAdmissionRefusal(ROOT, { code: "degraded-fence", detail: "identity-unavailable" }),
    describeAdmissionRefusal(ROOT, { code: "quarantine-pending", detail: "a standing journal" }),
    describeAdmissionRefusal(ROOT, { code: "migration-not-exclusive", detail: "a daemon is running" }),
    describeAdmissionRefusal(ROOT, { code: "reserve-foreign", detail: "wrong-size" }),
    describeGenesisOutcome(ROOT, { kind: "established", authorityId: "a".repeat(32) }),
    describeGenesisOutcome(ROOT, { kind: "already-established" }),
    ...(["legacy-present", "artifact-present", "evidence-missing"] as const)
      .map((reason) => describeGenesisOutcome(ROOT, { kind: "refused", reason })),
    describeMigrationHalt(ROOT, halt("reserved-path", { underlyingCode: "EIO" }), true),
    describeMigrationHalt(ROOT, halt("reserved-path", { underlyingCode: "staging-inode" }), true),
    describeMigrationHalt(ROOT, halt("reserved-path", { underlyingCode: "abort-after-flip" }), false),
    describeFormatTooNew("/w/.rbox/state.json"),
    describeLockRefusal({ code: "degraded-fence", detail: "identity-unavailable" }),
    describeLockRefusal({ code: "memory-admission", detail: "needs 4 GB of parse headroom" }),
    describeWorkspaceBusy(),
    describeAuthorityCorruption("the database does not carry the marker's authority id"),
  ];
}

// -------------------------------------------------------------- the four fixes

test("reserved-path never claims a file was found, because most of its rows have none", () => {
  // 163's authority matrix row for a workspace with NO state at all reaches this
  // code, and so does every corruption verdict `authority.ts`, `classifier.ts`,
  // and `retirement.ts` raise. The sentence has to be true for all of them.
  const copy: OperatorCopy = MIGRATION_HALT_COPY["reserved-path"];
  expect(copy.human.problem).not.toMatch(/found an unexpected file/);
  expect(copy.human.problem).toMatch(/weren't the ones it expected/);
  // And the remedy is an action, not the command that just printed this.
  expect(copy.human.command).not.toBe("rbox doctor");
  expect(copy.human.command).toMatch(/rbox migrate/);
});

test("the underlyingCode tokens are rendered, and a developer sentence never is", () => {
  const known = describeMigrationHalt(ROOT, halt("verification", { underlyingCode: "semantic-digest" }), true);
  expect(known.facts.join(" ")).toContain("content fingerprint");

  // An errno is evidence a user can act on, and it reads as one.
  const errno = describeMigrationHalt(ROOT, halt("filesystem-full", { underlyingCode: "ENOSPC" }), true);
  expect(errno.facts.join(" ")).toContain("ENOSPC");

  // A free-text corruption detail is a sentence rbox wrote for ITSELF. Two real
  // ones from the tree, neither of which may reach the surface as itself.
  for (const prose of [
    "a halted retirement resumes only through rbox doctor --retry-state-migration",
    "this workspace has no durable config stream to bind its reserve to",
  ]) {
    const report = describeMigrationHalt(ROOT, halt("reserved-path", { underlyingCode: prose }), true);
    expect(report.facts.join(" ")).not.toContain(prose);
    expect(report.facts.join(" ")).toContain("rbox doctor --report");
  }
});

test("reserved-path's remedy splits by producer class, and only one class names a file", () => {
  // ~40 producers across eight modules raise `reserved-path`, and one remedy was
  // wrong for most of them. The classes are derived from `underlyingCode`.
  const environment = describeMigrationHalt(ROOT, halt("reserved-path", { underlyingCode: "EIO" }), true);
  expect(environment.finding.problem).toContain("system refused an operation");
  expect(environment.finding.command).toBe("rbox doctor");
  expect(environment.facts.join(" ")).not.toMatch(/state\.db|move .* aside/);

  const internal = describeMigrationHalt(ROOT, halt("reserved-path"), true);
  expect(internal.finding.problem).toContain("doesn't recognise");
  expect(internal.finding.command).toContain("--report");
  // THE HAZARD: the blanket file list this replaced named the live `state.db`
  // under a command telling a non-developer to move things aside.
  expect(internal.facts.join(" ")).not.toContain("state.db");
  expect(internal.finding.command).not.toMatch(/aside/);

  const occupied = describeMigrationHalt(ROOT, halt("reserved-path", { underlyingCode: "staging-inode" }), true);
  expect(occupied.finding.problem).toContain("Something rbox didn't write");
  expect(occupied.finding.command).toContain("aside");
});

test("the post-flip abort refuses with its own words and its own machine id", () => {
  // 222 §7.3, and 5A's B4 guard: the one `reserved-path` producer a user really
  // meets. Without its own token it would have read as the generic catch-all and
  // lost the re-adoption remedy entirely.
  const report = describeMigrationHalt(ROOT, halt("reserved-path", { underlyingCode: "abort-after-flip" }), false);
  expect(report.outcome).toBe("halted:reserved-path:abort-after-flip");
  expect(report.finding.id).toBe("state-migration/abort-after-flip");
  expect(report.finding.problem).toContain("already been converted");
  expect(report.finding.command).toContain("rbox adopt");
});

test("no message ever carries a path, an errno, or a stack frame out of an exception", () => {
  // Exception messages compose: `StateAuthorityCorruptError`'s detail carries the
  // store's open reason, which carries a Node `Error:` with an absolute path.
  const corrupt = describeAuthorityCorruption(
    "not-a-database: cannot open state store /tmp/ws/.rbox/state/state.db: Error: ENOENT: no such file or directory, open '/tmp/ws/.rbox/state/state.db'",
  );
  const whole = [corrupt.finding.problem, corrupt.finding.safety, ...corrupt.facts].join(" ");
  expect(whole).not.toContain("ENOENT");
  expect(whole).not.toContain("/tmp/ws");
  expect(whole).not.toContain("Error:");
  expect(corrupt.facts.join(" ")).toContain("rbox doctor --report");

  // A SHORT authored detail is still worth showing — the guard is about shape,
  // not about hiding everything.
  const authored = describeAdmissionRefusal(ROOT, { code: "degraded-fence", detail: "identity-unavailable" });
  expect(authored.facts.join(" ")).toContain("identity-unavailable");
});

test("the format-too-new barrier has copy, so it can never arrive as a stack trace", () => {
  const report = describeFormatTooNew("/w/.rbox/state.json");
  expect(report.ok).toBeFalse();
  expect(report.finding.command).toBe("rbox upgrade");
  expect(report.finding.safety).toContain("leave them alone");
});

test("source-oversize names the file's size against the cap, in that order", () => {
  const report = describeMigrationHalt(
    ROOT, halt("source-oversize", { required: 900 * 1024 * 1024, available: RESET_MATERIALIZED_BYTE_LIMIT }), false,
  );
  const line = report.facts.find((fact) => fact.includes("state file is"))!;
  expect(line).toBeDefined();
  // The old generic sentence said "N available against M required", which for
  // this halt printed the CAP as what was available and the file as what was
  // required — exactly backwards.
  expect(line).not.toMatch(/available against/);
  expect(line.indexOf("943.7 MB")).toBeLessThan(line.indexOf("536.9 MB"));
});

test("no message ever contains the word unknown where a number belongs", () => {
  for (const report of everyReport()) {
    for (const fact of report.facts) expect(fact, report.outcome).not.toMatch(/\bunknown\b/);
  }
  // A halt carrying neither number renders no measurement line at all, rather
  // than a sentence with holes in it.
  const bare = describeMigrationHalt(ROOT, halt("disk-preflight"), true);
  expect(bare.facts.filter((fact) => fact.includes("free"))).toEqual([]);
});

test("nothing-to-abort is its own message and never says the workspace was migrated", () => {
  const nothing = describeMigrationOutcome(ROOT, { kind: "nothing-to-abort" });
  const already = describeMigrationOutcome(ROOT, { kind: "already-migrated" });
  expect(nothing.finding.id).not.toBe(already.finding.id);
  expect(nothing.finding.problem).not.toMatch(/new format/);
  expect(nothing.finding.problem).toMatch(/nothing to stop/);
  expect(nothing.ok).toBeTrue();
});

// ------------------------------------------------------- standing prohibitions

test("no message advises deleting the authority marker or restoring a backup", () => {
  for (const report of everyReport()) {
    const whole = [report.finding.problem, report.finding.safety, report.finding.command ?? "", ...report.facts].join(" ");
    expect(whole, report.outcome).not.toMatch(/delete .*state\.json|delete the marker/i);
    expect(whole, report.outcome).not.toMatch(/restore (the |a )?backup/i);
  }
});

test("every message answers all three questions and names no internal noun", () => {
  // The copy bar: what happened, what it means for their files, what to do next.
  // "control record", "witness", and the phase names are this codebase's words,
  // not a user's.
  const forbidden = /control record|witness|migration control|\bM[0-7]\b|CAS|inode|sqlite/i;
  for (const report of everyReport()) {
    expect(report.finding.problem.length, report.outcome).toBeGreaterThan(20);
    expect(report.finding.safety.length, report.outcome).toBeGreaterThan(10);
    const words = [report.finding.problem, report.finding.safety, report.finding.command ?? ""].join(" ");
    expect(words, report.outcome).not.toMatch(forbidden);
  }
});

test("every outcome that is not ok offers exactly one command", () => {
  for (const report of everyReport()) {
    if (report.ok) continue;
    expect(report.finding.command, report.outcome).toBeDefined();
  }
});

test("cleanup-deferred is the one halt that is ok, because the workspace is working", () => {
  // 222 §6.3, ratified: "fully working on the new format and syncing normally".
  const deferred = describeMigrationHalt(ROOT, halt("cleanup-deferred"), true);
  expect(deferred.ok).toBeTrue();
  expect(deferred.finding.safety).toContain("syncing normally");
  for (const code of Object.keys(MIGRATION_HALT_COPY) as MigrationHaltCode[]) {
    if (code === "cleanup-deferred") continue;
    expect(describeMigrationHalt(ROOT, halt(code), true).ok, code).toBeFalse();
  }
});

// ------------------------------------------------------------------ the twins

test("the human render and the JSON twin carry the same facts", () => {
  const report = describeMigrationHalt(
    ROOT, halt("filesystem-full", { required: 4096, available: 512, underlyingCode: "ENOSPC" }), true,
  );
  const lines = renderOperatorReport(report);
  expect(lines[0]).toBe(report.finding.problem);
  expect(lines).toContain(report.finding.safety);
  expect(lines.at(-1)).toBe(`Next: ${report.finding.command!}`);

  const json = operatorReportJson(report);
  expect(json.schemaVersion).toBe(1);
  expect(json.ok).toBeFalse();
  expect(json.outcome).toBe("halted:filesystem-full");
  expect(json.id).toBe("state-migration/filesystem-full");
  expect(json.facts).toEqual(report.facts);
});

test("a non-durable halt says so, because it will be retried rather than stay stopped", () => {
  const durable = describeMigrationHalt(ROOT, halt("verification"), true);
  const inProcess = describeMigrationHalt(ROOT, halt("verification"), false);
  expect(durable.facts.join(" ")).not.toContain("look again next time");
  expect(inProcess.facts.join(" ")).toContain("look again next time");
});

test("verification names the saved copy its safety line promises", () => {
  const report = describeMigrationHalt(ROOT, halt("verification"), true);
  expect(report.finding.safety).toContain("saved a copy");
  expect(report.facts.join(" ")).toContain("pre-163-latest.json.bak");
});

test("every machine id is unique and namespaced", () => {
  const ids = [
    ...Object.values(MIGRATION_HALT_COPY),
    ...Object.values(MIGRATION_REFUSAL_COPY),
    ...Object.values(GENESIS_REFUSAL_COPY),
    ...Object.values(MIGRATION_DISPOSITION_COPY),
  ].map((copy) => copy.machine.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^state-(migration|genesis|authority)\//);
});

test("the progress clauses describe the user's data, never a phase name", () => {
  for (const [phase, text] of Object.entries(MIGRATION_STEP_COPY)) {
    expect(text, phase).not.toMatch(/\bM[0-7]\b/);
    expect(text, phase).not.toMatch(/phase/i);
    expect(text.length, phase).toBeGreaterThan(12);
  }
});
