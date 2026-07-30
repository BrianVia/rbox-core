/**
 * The standing mutation gate (design 222 §7.9, U3 wave 5C).
 *
 * Eight review rounds of U3 found the same defect eight times: a correct guard
 * in production code with **no test that notices its deletion**. Each was caught
 * by a human reading a diff. This module makes that class fail CI instead.
 *
 * The gate is deliberately NOT exhaustive AST mutation. A full mutation run over
 * the state plane costs minutes and produces mostly equivalent mutants, which is
 * how mutation testing usually dies. Instead it is a **curated table**: one row
 * per guard that a reviewer identified as load-bearing, each naming the exact
 * source anchor and the one test file that must fail when the guard is removed.
 *
 * Three properties make it a gate rather than a checklist:
 *
 * 1. **The anchor must match exactly once.** Zero matches means the guard moved
 *    or was deleted and the row is stale; two means the anchor is ambiguous.
 *    Either way the gate fails and names the row. This is the same self-expiry
 *    the duplicate and file-size gates use — a row cannot outlive what it
 *    excuses.
 * 2. **The baseline must pass before the mutant is judged.** A test file that
 *    cannot run in the sandbox would otherwise "fail" under mutation for the
 *    wrong reason and report a healthy guard. That is precisely the defect class
 *    5C exists to close, so the gate would be reproducing its own bug. Every
 *    named test file is therefore run unmutated first, and a baseline failure is
 *    reported as a BROKEN row, never as a surviving guard.
 * 3. **A surviving mutant fails loudly**, naming the guard, the file, the line,
 *    and the test that was supposed to notice.
 *
 * Sandbox: `src/` is copied once into `.cache/mutation-gate/src` and mutated in
 * place there, so the working tree is never modified and a concurrent test run
 * is unaffected. The copy lives inside the repo so that bare imports still
 * resolve through the repo's own `node_modules`.
 */
import fs from "node:fs";
import path from "node:path";

export interface MutationGuard {
  /** Stable id, used in failure messages. */
  readonly id: string;
  /** Source file, relative to `src/`. */
  readonly file: string;
  /** The guard's exact text. Must occur EXACTLY ONCE in the file. */
  readonly anchor: string;
  /** What the guard becomes when removed. */
  readonly removed: string;
  /** The one test file, relative to `src/`, that must fail without the guard. */
  readonly test: string;
  /** Why this guard is load-bearing. Enforced to be a real sentence. */
  readonly reason: string;
}

/**
 * The curated list. Add a row when a review finds a guard whose deletion no test
 * would catch; delete a row only when the guard itself is deliberately retired.
 */
export const MUTATION_GUARDS: readonly MutationGuard[] = [
  {
    id: "control-cas-identity",
    file: "cli/state-plane/migration/control-publication.ts",
    anchor: "current.migrationId !== expect.migrationId || current.controlRevision !== expect.revision",
    removed: "false",
    test: "cli/state-plane/migration/control.test.ts",
    reason:
      "The compare-and-swap on (migrationId, controlRevision) is the only thing preventing a stale observation from publishing over a revision it never saw; without it two admitted migrations interleave silently.",
  },
  {
    id: "cleanup-enospc-predicate",
    file: "cli/state-plane/migration/cleanup.ts",
    anchor: 'return code === "ENOSPC" || code === "EDQUOT";',
    removed: "return false;",
    test: "cli/state-plane/migration/cleanup.test.ts",
    reason:
      "A full disk during cleanup must publish cleanup-deferred against the exact cursor; misclassifying ENOSPC as an ordinary error turns a resumable halt into an unhandled throw after Q is already live.",
  },
  {
    id: "runway-enospc-predicate",
    file: "cli/state-plane/migration/control-publication.ts",
    anchor: 'return code === "ENOSPC" || code === "EDQUOT";',
    removed: "return false;",
    test: "cli/state-plane/migration/guard-coverage.test.ts",
    reason:
      "ENOSPC and EDQUOT are the two conditions the prebuilt runway exists for; if neither is recognised the runway is never consumed and a disk-full halt cannot be published at all.",
  },
  {
    id: "phase-receipt-phase-match",
    file: "cli/state-plane/migration/phase-io.ts",
    anchor: "if (receipt.phase !== expected) {",
    removed: "if (false) {",
    test: "cli/state-plane/migration/guard-coverage.test.ts",
    reason:
      "A phase body may only run on a receipt for the phase it follows; without this a misrouted receipt lets M4's proof run against M2's witness and the phase table stops being a sequence.",
  },
  {
    id: "source-rebracket",
    file: "cli/state-plane/migration/phase-io.ts",
    anchor: 'halt("verification", false, "the legacy document is no longer the one this migration recorded");',
    removed: "void 0;",
    test: "cli/state-plane/migration/guard-coverage.test.ts",
    reason:
      "Every mutator re-brackets the recorded source before acting; deleting the check lets a legacy document that changed mid-migration be imported as if it were the one the control recorded, which is the whole source-changed disposition.",
  },
  {
    id: "flip-last-instant-reverify",
    file: "cli/state-plane/migration/authority-flip.ts",
    anchor: "if (final.sha256 !== witness.completion.sourceJsonSha256) {",
    removed: "if (false) {",
    test: "cli/state-plane/migration/guard-coverage.test.ts",
    reason:
      "222 §5.2's M6 row calls this the last operation before the rename with nothing between, and §6.2's legacy-write-detected disposition is reachable only here; without it an older rbox's write inside the check-to-rename microwindow is flipped over and silently lost.",
  },
];

const REPO = path.resolve(import.meta.dir, "..");
const SANDBOX = path.join(REPO, ".cache", "mutation-gate");

export interface GuardVerdict {
  readonly id: string;
  /** `killed` = the guard is covered. Everything else fails the gate. */
  readonly status: "killed" | "survived" | "stale-anchor" | "baseline-broken";
  readonly detail: string;
}

/** Anchor health only — cheap, and the half of the gate worth running everywhere. */
export function checkAnchors(root = REPO): GuardVerdict[] {
  return MUTATION_GUARDS.map((guard) => {
    const file = path.join(root, "src", guard.file);
    if (!fs.existsSync(file)) {
      return { id: guard.id, status: "stale-anchor" as const, detail: `${guard.file} does not exist` };
    }
    const text = fs.readFileSync(file, "utf8");
    const count = text.split(guard.anchor).length - 1;
    if (count !== 1) {
      return {
        id: guard.id,
        status: "stale-anchor" as const,
        detail: `anchor matched ${count} times in ${guard.file} (must be exactly 1) — re-anchor the row or delete it if the guard was retired`,
      };
    }
    return { id: guard.id, status: "killed" as const, detail: "anchor is exact" };
  });
}

function prepareSandbox(): string {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.cpSync(path.join(REPO, "src"), path.join(SANDBOX, "src"), { recursive: true });
  return path.join(SANDBOX, "src");
}

function runTest(sandboxSrc: string, testFile: string): { ok: boolean; output: string } {
  const proc = Bun.spawnSync(
    [process.execPath, "test", path.join(sandboxSrc, testFile), "--bail"],
    { cwd: REPO, stdout: "pipe", stderr: "pipe", env: { ...process.env, RBOX_MUTATION_GATE: "1" } },
  );
  const output = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
  return { ok: proc.exitCode === 0, output };
}

/** The full sweep: baseline every named test, then kill each guard in turn. */
export function runMutationGate(): GuardVerdict[] {
  const anchors = checkAnchors();
  const stale = anchors.filter((v) => v.status !== "killed");
  if (stale.length > 0) return anchors;

  const sandboxSrc = prepareSandbox();
  const verdicts: GuardVerdict[] = [];

  // Baseline once per distinct test file. A test that cannot pass unmutated
  // cannot testify about a mutant.
  const baselines = new Map<string, boolean>();
  for (const test of new Set(MUTATION_GUARDS.map((g) => g.test))) {
    baselines.set(test, runTest(sandboxSrc, test).ok);
  }

  for (const guard of MUTATION_GUARDS) {
    if (baselines.get(guard.test) !== true) {
      verdicts.push({
        id: guard.id,
        status: "baseline-broken",
        detail: `${guard.test} does not pass unmutated in the sandbox, so it cannot prove anything about ${guard.id}`,
      });
      continue;
    }
    const target = path.join(sandboxSrc, guard.file);
    const original = fs.readFileSync(target, "utf8");
    fs.writeFileSync(target, original.replace(guard.anchor, guard.removed));
    const mutated = runTest(sandboxSrc, guard.test);
    fs.writeFileSync(target, original);
    verdicts.push(
      mutated.ok
        ? {
          id: guard.id,
          status: "survived",
          detail: `removing the guard in ${guard.file} left ${guard.test} passing — that guard has no test that notices its deletion`,
        }
        : { id: guard.id, status: "killed", detail: `${guard.test} fails without the guard` },
    );
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  return verdicts;
}

if (import.meta.main) {
  const verdicts = runMutationGate();
  for (const v of verdicts) console.log(`${v.status === "killed" ? "ok  " : "FAIL"} ${v.id} — ${v.detail}`);
  const failed = verdicts.filter((v) => v.status !== "killed");
  if (failed.length > 0) {
    console.error(`::error::mutation gate: ${failed.length} of ${verdicts.length} guards are not covered`);
    process.exit(1);
  }
  console.log(`mutation gate: ${verdicts.length} guards covered`);
}
