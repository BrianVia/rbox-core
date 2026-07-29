/**
 * The module-size gate.
 *
 * Design 163 states the law: "Production files target <=300 nonblank lines; 400
 * lines or 25 KiB is a hard CI guard failure." Nothing enforced it. The law was
 * a sentence in a design doc, so a 636-line draft would have merged clean, and
 * the only thing standing between the tree and unbounded modules was whoever
 * happened to be reading the diff.
 *
 * The unit is NONBLANK lines. 163's first band says so outright ("<=300 nonblank
 * lines"); the second band says only "400 lines", and a lane read that as total
 * lines and landed a module at 404 total / 384 nonblank. Both bands measure the
 * same thing — a file's blank lines are its paragraph breaks, and a gate that
 * counts them punishes the formatting that makes a long file readable. So 384
 * nonblank passes, and the ambiguity is pinned here rather than re-litigated in
 * the next review.
 *
 * The byte ceiling is a second, independent bound: a file can sit under 400
 * nonblank lines and still be 40 KiB of long lines (generated maps, wide table
 * literals). Either bound alone fails the file.
 *
 * Scope is production `.ts` under `src/` — the same scope as the
 * duplicate-declaration gate beside it. `src/` is what links into the one CLI
 * binary. Tests and their helpers are exempt: a test file's length tracks the
 * number of cases it pins, and splitting a table of cases to satisfy a line
 * count makes the suite worse, not better.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dir, "../../..", "src");

const MAX_NONBLANK_LINES = 400;
const MAX_BYTES = 25 * 1024;

/** The debt that predates the gate. 163 stated the law and nothing enforced it,
 * so 69 modules drifted past it — this list is the measured tree on the day the
 * gate landed, not a policy. Every entry records what it was over by, so the
 * next reader can see the size of the split it is waiting on.
 *
 * The entries are self-expiring: the gate fails if an allowlisted file has been
 * split (or deleted) and no longer needs the excuse, the same way the
 * duplicate-declaration gate pins its collision counts. An excuse that outlives
 * the problem is how an allowlist quietly becomes the policy. Nothing may be
 * added here — a new file over the limit is the defect this gate exists to
 * catch. */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  ["src/cli/activity.ts", "pending split — 442 nonblank lines when the gate landed"],
  ["src/cli/adopt-git.ts", "pending split — 557 nonblank lines and 32.7 KiB when the gate landed"],
  ["src/cli/adopt-journal.ts", "pending split — 431 nonblank lines when the gate landed"],
  ["src/cli/auth/device-login.ts", "pending split — 658 nonblank lines and 28.0 KiB when the gate landed"],
  ["src/cli/auth/genesis-destination-flow.ts", "pending split — 432 nonblank lines when the gate landed"],
  ["src/cli/credentials.ts", "pending split — 900 nonblank lines and 42.3 KiB when the gate landed"],
  ["src/cli/daemon/ambient-status.ts", "pending split — 544 nonblank lines when the gate landed"],
  ["src/cli/daemon/daemon.ts", "pending split — 3215 nonblank lines and 154.5 KiB when the gate landed"],
  ["src/cli/daemon/git-ref-watch.ts", "pending split — 800 nonblank lines and 36.7 KiB when the gate landed"],
  ["src/cli/daemon/key-delivery-fulfill.ts", "pending split — 1006 nonblank lines and 38.8 KiB when the gate landed"],
  ["src/cli/daemon/process-control.ts", "pending split — 495 nonblank lines when the gate landed"],
  ["src/cli/daemon/watcher.ts", "pending split — 424 nonblank lines when the gate landed"],
  ["src/cli/doctor-cmd.ts", "pending split — 933 nonblank lines and 42.8 KiB when the gate landed"],
  ["src/cli/doctor-triage.ts", "pending split — 456 nonblank lines when the gate landed"],
  ["src/cli/e2ee-client.ts", "pending split — 765 nonblank lines and 51.9 KiB when the gate landed"],
  ["src/cli/e2ee-remote.ts", "pending split — 987 nonblank lines and 54.0 KiB when the gate landed"],
  ["src/cli/genesis-durable.ts", "pending split — 707 nonblank lines and 51.9 KiB when the gate landed"],
  ["src/cli/git/resolve-command.ts", "pending split — 1048 nonblank lines and 52.5 KiB when the gate landed"],
  ["src/cli/help-registry.ts", "pending split — 797 nonblank lines and 35.9 KiB when the gate landed"],
  ["src/cli/init-cmd.ts", "pending split — 680 nonblank lines and 35.0 KiB when the gate landed"],
  ["src/cli/login-attempt-journal.ts", "pending split — 686 nonblank lines and 26.0 KiB when the gate landed"],
  ["src/cli/main-dispatch.ts", "pending split — 712 nonblank lines and 34.9 KiB when the gate landed"],
  ["src/cli/publish-pipeline/pipeline.ts", "pending split — 504 nonblank lines when the gate landed"],
  ["src/cli/recovery-kit-1password.ts", "pending split — 574 nonblank lines when the gate landed"],
  ["src/cli/recovery-kit.ts", "pending split — 543 nonblank lines and 32.4 KiB when the gate landed"],
  ["src/cli/remote/blob-batch/uploader.ts", "pending split — 480 nonblank lines when the gate landed"],
  ["src/cli/reset-journal.ts", "pending split — 457 nonblank lines and 25.5 KiB when the gate landed"],
  ["src/cli/reset-quarantine.ts", "pending split — 444 nonblank lines when the gate landed"],
  ["src/cli/reset-state.ts", "pending split — 473 nonblank lines when the gate landed"],
  ["src/cli/setup-cmd.ts", "pending split — 873 nonblank lines and 44.8 KiB when the gate landed"],
  ["src/cli/state-plane/adapters/legacy-json-store.ts", "pending split — 417 nonblank lines when the gate landed"],
  ["src/cli/state-plane/reset/recovery.ts", "pending split — 455 nonblank lines when the gate landed"],
  ["src/cli/status-projection.ts", "pending split — 434 nonblank lines when the gate landed"],
  ["src/cli/status-view.ts", "pending split — 862 nonblank lines and 45.1 KiB when the gate landed"],
  ["src/cli/sync-git/apply.ts", "pending split — 1470 nonblank lines and 77.7 KiB when the gate landed"],
  ["src/cli/sync-git/base-composer.ts", "pending split — 611 nonblank lines and 28.0 KiB when the gate landed"],
  ["src/cli/sync-git/clean-materialization.ts", "pending split — 451 nonblank lines when the gate landed"],
  ["src/cli/sync-git/deferral-hygiene.ts", "pending split — 507 nonblank lines when the gate landed"],
  ["src/cli/sync-git/follow.ts", "pending split — 1800 nonblank lines and 88.7 KiB when the gate landed"],
  ["src/cli/sync-git/plan.ts", "pending split — 1447 nonblank lines and 71.9 KiB when the gate landed"],
  ["src/cli/sync-git/state-cas-locks.ts", "pending split — 572 nonblank lines when the gate landed"],
  ["src/cli/sync-recovery.ts", "pending split — 542 nonblank lines and 26.9 KiB when the gate landed"],
  ["src/cli/sync-state-model.ts", "pending split — 446 nonblank lines when the gate landed"],
  ["src/cli/sync-state.ts", "pending split — 599 nonblank lines and 30.8 KiB when the gate landed"],
  ["src/cli/sync/pull.ts", "pending split — 465 nonblank lines when the gate landed"],
  ["src/cli/sync/push.ts", "pending split — 944 nonblank lines and 50.1 KiB when the gate landed"],
  ["src/cli/upgrade-cmd.ts", "pending split — 453 nonblank lines when the gate landed"],
  ["src/engine/apply-receipt.ts", "pending split — 689 nonblank lines and 29.3 KiB when the gate landed"],
  ["src/engine/apply.ts", "pending split — 488 nonblank lines when the gate landed"],
  ["src/engine/crypto-pool/pool.ts", "pending split — 814 nonblank lines and 34.2 KiB when the gate landed"],
  ["src/engine/e2ee/bip39-wordlist.ts", "generated data, behavior-free — 163's documented exception for generated maps; 2053 nonblank lines is the BIP-39 wordlist, one word per line"],
  ["src/engine/e2ee/session.ts", "pending split — 535 nonblank lines and 28.4 KiB when the gate landed"],
  ["src/engine/entry-arena/owner.ts", "pending split — 455 nonblank lines when the gate landed"],
  ["src/engine/git/apply.ts", "pending split — 761 nonblank lines and 36.7 KiB when the gate landed"],
  ["src/engine/git/base-artifacts.ts", "pending split — 465 nonblank lines and 29.6 KiB when the gate landed"],
  ["src/engine/git/checkout-txn.ts", "pending split — 956 nonblank lines and 50.4 KiB when the gate landed"],
  ["src/engine/git/config-txn.ts", "pending split — 486 nonblank lines when the gate landed"],
  ["src/engine/git/journal.ts", "pending split — 933 nonblank lines and 51.0 KiB when the gate landed"],
  ["src/engine/git/keep-pins.ts", "pending split — 716 nonblank lines and 34.0 KiB when the gate landed"],
  ["src/engine/git/lockfile.ts", "pending split — 1368 nonblank lines and 65.0 KiB when the gate landed"],
  ["src/engine/git/p-repair-transaction.ts", "pending split — 469 nonblank lines when the gate landed"],
  ["src/engine/git/p-repair.ts", "pending split — 413 nonblank lines when the gate landed"],
  ["src/engine/git/shared.ts", "pending split — 735 nonblank lines and 32.7 KiB when the gate landed"],
  ["src/engine/ignore.ts", "pending split — 714 nonblank lines and 31.3 KiB when the gate landed"],
  ["src/engine/index.ts", "pending split — 413 nonblank lines when the gate landed"],
  ["src/engine/manifest-delta.ts", "pending split — 486 nonblank lines when the gate landed"],
  ["src/engine/manifest.ts", "pending split — 665 nonblank lines and 29.7 KiB when the gate landed"],
]);

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test-helper.ts")) continue;
    files.push(entry.split(path.sep).join("/"));
  }
  return files.sort();
}

interface Measurement {
  file: string;
  nonblankLines: number;
  bytes: number;
}

function sizeOf(file: string, text: string): Measurement {
  return {
    file,
    nonblankLines: text.split("\n").filter((line) => line.trim() !== "").length,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

function measure(relative: string): Measurement {
  return sizeOf(`src/${relative}`, fs.readFileSync(path.join(SRC, relative), "utf8"));
}

function overLimit(measurement: Measurement): boolean {
  return measurement.nonblankLines > MAX_NONBLANK_LINES || measurement.bytes > MAX_BYTES;
}

function report(measurement: Measurement): string {
  const kib = (measurement.bytes / 1024).toFixed(1);
  return `${measurement.file} is ${measurement.nonblankLines} nonblank lines and ${kib} KiB`
    + ` — the hard limit is ${MAX_NONBLANK_LINES} nonblank lines and ${MAX_BYTES / 1024} KiB`
    + " (blank lines are not counted). Split it behind a facade — see 163's module-size law.";
}

describe("module size", () => {
  test("no production module exceeds 400 nonblank lines or 25 KiB", () => {
    const files = sourceFiles();
    expect(files.length, "the source scan found nothing — it is broken, not clean")
      .toBeGreaterThan(200);

    const offenders = files
      .map(measure)
      .filter((measurement) => overLimit(measurement) && !ALLOWED.has(measurement.file))
      .map(report);
    expect(offenders).toEqual([]);
  });

  test("the ceiling counts nonblank lines, not total lines", () => {
    // The exact shape a lane landed while 163's second band was ambiguous:
    // 404 total lines, 384 of them nonblank. It passes, and it has to keep
    // passing, or the gate is quietly measuring something else.
    const padded = [...Array(384).fill("const a = 1;"), ...Array(20).fill("")].join("\n");
    expect(padded.split("\n").length).toBe(404);
    expect(overLimit(sizeOf("fixture.ts", padded))).toBeFalse();

    const bare = Array(401).fill("const a = 1;").join("\n");
    expect(overLimit(sizeOf("fixture.ts", bare))).toBeTrue();

    // 25 KiB fails a file that is nowhere near the line ceiling.
    const wide = Array(40).fill(`const a = "${"x".repeat(700)}";`).join("\n");
    expect(sizeOf("fixture.ts", wide).nonblankLines).toBeLessThan(MAX_NONBLANK_LINES);
    expect(overLimit(sizeOf("fixture.ts", wide))).toBeTrue();
  });

  test("every allowlist entry states a reason", () => {
    for (const [file, reason] of ALLOWED) expect(reason.length, file).toBeGreaterThan(30);
  });

  test("no allowlist entry outlives the file it excuses", () => {
    for (const file of ALLOWED.keys()) {
      const absolute = path.resolve(SRC, "..", file);
      expect(fs.existsSync(absolute), `ALLOWED still excuses ${file}, which no longer exists`)
        .toBeTrue();
      expect(
        overLimit(measure(path.relative(SRC, absolute).split(path.sep).join("/"))),
        `ALLOWED still excuses ${file}, which is now within the limit — delete the entry`,
      ).toBeTrue();
    }
  });
});
