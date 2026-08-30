/**
 * A halted daemon, explained: one typed halt reason in, one remedy out.
 *
 * The daemon classifies WHY it stopped (`activity.ts`'s `typedReason`); this
 * module owns the only translation of those classifications into what a
 * non-expert is told and the single command that clears each one. Readers never
 * classify the raw `reason` string — the one exception is the mass-delete scale
 * below, which reads counts the producer already wrote into that sentence.
 *
 * Split out of `doctor-triage.ts` (#813): halt remedies are a closed set with
 * their own consent rules, and every new safety halt lands here rather than
 * growing the general triage module.
 */
import type { DaemonActivity } from "./activity.js";
import { SAFE_LOCAL_FILES, scoped, type TriageFinding } from "./doctor-finding.js";

type Halt = NonNullable<DaemonActivity["halt"]>;

function massDeleteCounts(reason: string): { deletes: number; tracked: number } | undefined {
  const match = /(\d+) of (\d+) tracked files/.exec(reason);
  return match ? { deletes: Number(match[1]), tracked: Number(match[2]) } : undefined;
}

/** The remedy is consent to a SPECIFIC deletion, so the copy names what is being
 * consented to and the scale of it. `rbox sync --allow-mass-delete` is never
 * offered: that waives the guard in both directions, including an unrelated one. */
function massDeleteFinding(root: string, halt: Halt, op: "pull" | "push"): TriageFinding {
  const counts = massDeleteCounts(halt.reason);
  const scale = counts ? `${counts.deletes} of your ${counts.tracked} synced files` : "an unusually large number of files";
  const target = op === "pull" ? `delete ${scale} from this machine` : `delete ${scale} everywhere else you sync`;
  const consent = op === "pull" ? "that local deletion" : "that deletion for your other machines";
  return {
    id: "halt:mass-delete",
    severity: "blocked",
    problem: `Syncing stopped because finishing it would ${target}, and rbox will not do that without your say-so.`,
    safety: `Nothing has been deleted — rbox stopped before touching anything. The command below CONFIRMS ${consent}; check what is missing first.`,
    command: scoped(root, `rbox ${op} --allow-mass-delete`),
  };
}

export function haltFinding(root: string, halt: Halt): TriageFinding | undefined {
  switch (halt.typedReason?.kind) {
    case "mass-delete":
      return massDeleteFinding(root, halt, halt.typedReason.op);
    case "chain-repair":
      return {
        id: "halt:chain-repair",
        severity: "blocked",
        problem: "Syncing stopped because part of this workspace's sync history could not be read.",
        safety: `${SAFE_LOCAL_FILES} Your uploaded versions are still on the server.`,
        command: scoped(root, "rbox recover --repair-chain"),
      };
    // #813/#810: the halt reason is an authored sentence that already names the
    // dominating directory and its `rbox ignore` command — the whole point of
    // the refusal. Repeating a generic problem line here would bury it.
    case "too-many-entries":
      return {
        id: "halt:too-many-entries",
        severity: "blocked",
        problem: `Syncing stopped because this workspace holds more files than rbox can sync. ${halt.reason}`,
        safety: `${SAFE_LOCAL_FILES} Ignoring a directory only stops rbox syncing it; nothing is deleted.`,
        command: scoped(root, "rbox ignore --list"),
      };
    case "too-many-refs":
    case "body-too-large":
      return {
        id: `halt:${halt.typedReason.kind}`,
        severity: "blocked",
        problem: "Syncing stopped because one upload was larger than the service accepts.",
        safety: SAFE_LOCAL_FILES,
        command: scoped(root, "rbox doctor --report"),
      };
    case "push-conflict":
      return undefined;
    default:
      if (!halt.terminal) return undefined;
      return {
        id: "halt:unknown",
        severity: "blocked",
        problem: "Syncing stopped and will not retry on its own.",
        safety: SAFE_LOCAL_FILES,
        command: scoped(root, "rbox logs"),
      };
  }
}
