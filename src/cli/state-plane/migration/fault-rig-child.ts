/**
 * The 5C crash child (design 222 §7.2), modelled on U2's `crash-rig-child.ts`.
 *
 * A spawnable script, not a module: SIGKILL cannot be caught, so a kill point
 * only means anything in a process the test does not need back. The child does
 * NOT build a workspace — the parent does, and hands over a root that a real
 * legacy workspace already occupies. All this process does is take the real
 * entry point, interrupt it at a named syscall, and die. Every byte the parent
 * then inspects was written by production code.
 *
 * A point that never matches exits 65 with a message. An unreachable kill point
 * is a broken test, and it must read as one rather than as a clean pass — the
 * failure mode that let four earlier lanes ship fixtures for states the machine
 * cannot produce.
 *
 * Migration only. It deliberately does NOT drive genesis: §7.9 requires that
 * `migration/**` import nothing from `genesis.ts` and that exactly one module
 * (the coordinator) import both, and a harness is not exempt from a structural
 * rule it can silently break. `genesis-crash-matrix.test.ts` owns its own
 * in-process rig for the same reason, and because genesis performs most of its
 * work through `node:fs/promises` rather than the default export.
 *
 * usage: fault-rig-child migrate|abort ROOT SPEC_JSON
 *   SPEC_JSON: { point: StatePlaneFaultPoint, action: StatePlaneFaultAction }
 */
import { abortStateMigrationCmd } from "../../state-plane-cmd.js";
import { withStatePlaneLocks } from "../locks.js";
import { runMigration } from "./authority.js";
import {
  installStatePlaneFault, type StatePlaneFaultAction, type StatePlaneFaultPoint,
} from "./fault-rig.js";

const [command, root, specJson] = process.argv.slice(2);
if (!command || !root || !specJson) {
  console.error("usage: fault-rig-child migrate|abort ROOT SPEC_JSON");
  process.exit(64);
}

const spec = JSON.parse(specJson) as {
  point: StatePlaneFaultPoint & { match?: string };
  action: StatePlaneFaultAction;
};
const point: StatePlaneFaultPoint = {
  ...spec.point,
  match: spec.point.match === undefined ? undefined : new RegExp(spec.point.match),
};

const fault = installStatePlaneFault(point, spec.action);

const held = async <T>(fn: (locks: Parameters<Parameters<typeof withStatePlaneLocks>[1]>[0]) => Promise<T>): Promise<T> => {
  const outcome = await withStatePlaneLocks(root, fn);
  if (!outcome.held) throw new Error(`the lock bundle refused: ${outcome.refusal.code}`);
  return outcome.value;
};

let report: unknown;
try {
  if (command === "migrate") {
    report = await held((locks) => runMigration(root, { entry: "foreground-migrate", locks }));
  } else if (command === "abort") {
    report = { exitCode: await abortStateMigrationCmd(root, { log: () => undefined }) };
  } else {
    console.error(`unknown command: ${command}`);
    process.exit(64);
  }
} catch (error) {
  // A throw is a legitimate outcome for an errno point. The parent decides
  // whether it was the right one; the child only reports faithfully.
  report = { threw: String(error instanceof Error ? error.message : error) };
}

if (!fault.fired()) {
  console.error(
    `fault point was never reached: ${point.syscall} ${spec.point.match ?? "(any)"} #${point.nth ?? 1}`,
  );
  process.exit(65);
}
console.log(JSON.stringify(report));
