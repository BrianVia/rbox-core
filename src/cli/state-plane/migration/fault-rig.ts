/**
 * The 5C fault primitive (design 222 §7.2): drive the real machine to a real
 * instant and end it there.
 *
 * Every wave before this one built crash fixtures by hand — writing the control
 * record, the staging file, and the sidecars a crash was *believed* to leave.
 * Four separate defects came from that: a fixture recorded a disposition no
 * crash produces (4A), a verdict the classifier never returns (5B), an M4 halt
 * no corpus could reach (3A). Each was self-consistent and wrong. So this module
 * plants nothing. It patches one shared object, lets production perform its own
 * syscalls, and interrupts it between two of them. Whatever is on disk
 * afterwards is what the machine actually leaves, which is the only thing worth
 * asserting against.
 *
 * The seam is `import fs from "node:fs"`. Every migration and genesis module
 * uses that form and calls through the namespace object (`fs.renameSync(...)`),
 * so the property is resolved at call time and one assignment reaches all of
 * them at once. This is not a fake filesystem: the real syscall still runs for
 * every call that is not the targeted one, and for a `when: "after"` point it
 * runs for that one too.
 *
 * Because a SIGKILL cannot be caught, a killing point only works in a child
 * process — `fault-rig-child.ts` is that child. Non-killing actions (errno
 * injection, short writes) are in-process and restore on `afterEach`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** The errnos every phase's I/O row is written against (§5.2, `cleanup.ts:63`,
 * `begin.ts:265`). `EIO` is deliberately included even though no phase claims a
 * row for it: an unclassified errno must still fail closed, and 5C asserts that
 * rather than assuming it. */
export type FaultErrno = "ENOSPC" | "EDQUOT" | "EIO";

/**
 * Where to interrupt. `syscall` is a key of the `node:fs` default export;
 * `match` is tested against the string arguments joined by `\0`, so a point can
 * name one path without knowing the argument position.
 *
 * `nth` counts only calls that also satisfy `match`, and is 1-based. Counting
 * matched calls rather than all calls is what keeps a point stable when an
 * unrelated phase gains a write.
 */
export interface StatePlaneFaultPoint {
  readonly syscall: string;
  /**
   * Which module object to patch. Defaults to `node:fs`, which is what every
   * migration module calls through.
   *
   * `promises` exists because genesis does NOT: it performs most of its work —
   * including the intent publication, both renames, and both parent fsyncs —
   * through `node:fs/promises`, so a rig that patched only the default export
   * could not reach a single kill point 222 §7.2 names for genesis. That gap
   * was found by wave 5C's own genesis matrix, and it stayed findable only
   * because an unreached point exits 65 instead of passing quietly.
   */
  readonly surface?: "sync" | "promises";
  readonly match?: RegExp;
  readonly nth?: number;
  /** `after` lets the real syscall complete and interrupts before control
   * returns — the window where a physical effect is durable but the record that
   * describes it is not. `before` interrupts with the effect not yet applied. */
  readonly when?: "before" | "after";
}

export type StatePlaneFaultAction =
  | { readonly kind: "kill" }
  | { readonly kind: "errno"; readonly code: FaultErrno }
  /** `writeSync` returning fewer bytes than asked. A real ENOSPC on a large
   * write reaches the caller this way, not as a throw, and `cleanup-runway.ts`
   * synthesizes its own errno from the shortfall. */
  | { readonly kind: "short-write"; readonly bytes: number }
  /**
   * Perturb the world at this exact instant, then let the call return normally.
   *
   * This is how a concurrent writer is modelled without sleeping: 222's F5
   * microwindow (a legacy writer landing between M6's check and its rename) and
   * G3's window (an `L` published between genesis's sibling fsync and its
   * rename) are both "something else happened between these two syscalls", and
   * a timing-based fixture for either is a flake pretending to be a test.
   *
   * In-process only — the callback cannot cross into `fault-rig-child.ts`,
   * which takes its spec as JSON.
   */
  | { readonly kind: "side-effect"; readonly run: () => void };

export interface InstalledFault {
  /** How many times the point matched. Zero means the point is unreachable —
   * always a test failure, never a pass. */
  readonly matches: () => number;
  readonly fired: () => boolean;
  readonly restore: () => void;
}

const errnoOf = (code: FaultErrno, syscall: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: injected by the 5C fault rig at ${syscall}`), {
    code,
    syscall,
    errno: code === "ENOSPC" ? -28 : code === "EDQUOT" ? -122 : -5,
  });

/**
 * Patch one `fs` entry point until `restore()`.
 *
 * The replacement is a plain function rather than a bound arrow so that a
 * production caller passing `this` (nothing in `src/` does, but the shape should
 * not depend on that) is unaffected.
 */
export function installStatePlaneFault(
  point: StatePlaneFaultPoint,
  action: StatePlaneFaultAction,
): InstalledFault {
  const surface = point.surface ?? "sync";
  const table = (surface === "promises" ? fsp : fs) as unknown as Record<string, unknown>;
  const original = table[point.syscall];
  if (typeof original !== "function") {
    throw new TypeError(`fault rig: ${surface} surface has no callable ${point.syscall}`);
  }
  const call = original as (...args: unknown[]) => unknown;
  const target = point.nth ?? 1;
  const when = point.when ?? "after";
  let matches = 0;
  let fired = false;

  table[point.syscall] = function patched(this: unknown, ...args: unknown[]): unknown {
    const subject = args.filter((a) => typeof a === "string").join("\0");
    const hit = point.match === undefined || point.match.test(subject);
    if (!hit) return call.apply(this, args);
    matches += 1;
    if (matches !== target) return call.apply(this, args);
    fired = true;
    if (when === "before") return apply(action, () => call.apply(this, args), point.syscall);
    const result = call.apply(this, args);
    return apply(action, () => result, point.syscall);
  };

  return {
    matches: () => matches,
    fired: () => fired,
    restore: () => {
      table[point.syscall] = original;
    },
  };
}

function apply(
  action: StatePlaneFaultAction,
  proceed: () => unknown,
  syscall: string,
): unknown {
  if (action.kind === "kill") {
    // Uncatchable by construction: a phase body that could observe its own
    // interruption is not modelling a crash. Only valid in a child process.
    process.kill(process.pid, "SIGKILL");
    // Unreachable; keeps the return type honest for the type checker.
    return proceed();
  }
  if (action.kind === "errno") throw errnoOf(action.code, syscall);
  if (action.kind === "side-effect") {
    const result = proceed();
    action.run();
    return result;
  }
  // A short write reports success for fewer bytes than were offered.
  void proceed();
  return action.bytes;
}

/** Install several points at once; restore is LIFO. */
export function installStatePlaneFaults(
  specs: readonly { point: StatePlaneFaultPoint; action: StatePlaneFaultAction }[],
): InstalledFault {
  const installed = specs.map((s) => installStatePlaneFault(s.point, s.action));
  return {
    matches: () => installed.reduce((n, f) => n + f.matches(), 0),
    fired: () => installed.some((f) => f.fired()),
    restore: () => {
      for (const f of [...installed].reverse()) f.restore();
    },
  };
}

/**
 * Every byte under `.rbox`, sidecars included.
 *
 * 222 §7.1's r6 note is the reason this is not a comparison of one file: a
 * `-wal`/`-shm` left beside an untouched `Q` passes any "`Q` is byte-identical"
 * assertion while proving the opposite of what that assertion exists to prove.
 * The exclusions are the two things that legitimately differ between two runs of
 * the same command — lock files, whose contents are pids, and the locking health
 * probe, which records timings.
 */
export function rboxResidue(root: string): Record<string, string> {
  const base = path.join(root, ".rbox");
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(base, abs);
      if (entry.name.endsWith(".lock") || entry.name === "locking-health.json") continue;
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.isSymbolicLink()) {
        out[rel] = `symlink:${fs.readlinkSync(abs)}`;
        continue;
      }
      if (!entry.isFile()) {
        out[rel] = "special";
        continue;
      }
      out[rel] = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 16);
    }
  };
  walk(base);
  return out;
}

/** The residue paths only, which is what §7.3's table is written in terms of. */
export const rboxResiduePaths = (root: string): string[] => Object.keys(rboxResidue(root)).sort();
