/** Daemon-log redaction for the diagnostics bundle: the one place that turns
 * historical Git log TEXT back into a closed enum before it can leave the
 * machine.
 *
 * Extracted from `doctor-cmd.ts` (#832) so the redaction grammar has an owner
 * of its own — it is byte-frozen against what the daemon emits, and a new log
 * line must be taught here in the same PR or it is dropped. `doctor-cmd.ts`
 * re-exports `redactGitLogLines` so callers are unchanged.
 *
 * Never: rendering, network, or anything a user reads. */
import { GIT_DEFERRAL_REASONS } from "./sync-state-model.js";

const GIT_DEFERRAL_REASON_SET = new Set<string>(GIT_DEFERRAL_REASONS);

/** LOG-REDACTION classifier — not a status surface. It parses historical daemon
 * log TEXT back into a closed reason enum so diagnostics can be shipped without
 * local Git forensics, and is byte-frozen against `renderGitDeferralLine`'s
 * emitted grammar (status-view/git-render.ts). Nothing a user reads comes from
 * here; the human vocabulary lives in status-view/git-stories.ts. */
function logRedactionReasonOf(detail: string, fallback = "other"): string {
  const normalized = detail.toLowerCase().replace(/[ _]+/g, "-");
  for (const reason of GIT_DEFERRAL_REASON_SET) {
    if (normalized.includes(reason)) return reason;
  }
  if (/local edits|working (?:tree|files)|unstaged|porcelain/.test(detail.toLowerCase())) return "local-edits";
  if (/local index|\bstaged\b|\bindex\b/.test(detail.toLowerCase())) return "local-index";
  if (/operation|rebase|cherry-pick|sequencer|bisect|revert/.test(detail.toLowerCase())) return "local-operation";
  if (/branch (?:was )?deleted here|deleted (?:local )?branch|finishing (?:a )?branch deletion/.test(detail.toLowerCase())) return "deletion-pending";
  if (/local commits?|diverg|held refs?|\bheads?\b/.test(detail.toLowerCase())) return "local-commits";
  if (/stash/.test(detail.toLowerCase())) return "local-stash";
  if (/conflict/.test(detail.toLowerCase())) return "conflict";
  if (/\bbusy\b|lock/.test(detail.toLowerCase())) return "git-busy";
  if (/ownership|non-owned|does not own|outside workspace/.test(detail.toLowerCase())) return "worktree-ownership";
  if (/ignor/.test(detail.toLowerCase())) return "ignored-target";
  if (/ref-read-unreadable|refs? (?:could not|cannot) be read/.test(detail.toLowerCase())) return "ref-read-unreadable";
  if (/unreadable|cannot read|could not read/.test(detail.toLowerCase())) return "unreadable";
  if (/artifact|bundle|op-state/.test(detail.toLowerCase())) return "artifact";
  if (/config/.test(detail.toLowerCase())) return "config";
  if (/containment|outside root/.test(detail.toLowerCase())) return "containment";
  if (/unsupported/.test(detail.toLowerCase())) return "unsupported";
  return fallback;
}

/** Recognize one historical daemon log line and reduce it to its redacted key.
 * Fail-closed: an unrecognized line is omitted from diagnostics entirely, so the
 * emitted grammar must stay byte-stable or be updated here in the same PR. */
function classifyGitLogLineForRedaction(message: string): { text: string; key: string } | undefined {
  let klass: string;
  let reason = "other";
  let age = "-";
  let match: RegExpExecArray | null;

  if ((match = /^git deferred (\d+m|1h|1d|7d|14d|30d):\s+(.+?) on (?:branch .+|detached checkout|checkout unavailable) \(.+\)(?: \(working files changed since\))?$/.exec(message))) {
    klass = "deferred";
    age = match[1]!;
    reason = logRedactionReasonOf(match[2]!);
  } else if ((match = /^git-sync deferred\s+[^:\r\n]+:\s*(.+)$/.exec(message))) {
    klass = "deferred";
    reason = logRedactionReasonOf(match[1]!);
  } else if ((match = /^git-sync CONFLICT\s+(.+)$/.exec(message))) {
    klass = "conflict";
    reason = "conflict";
  } else if ((match = /^git-sync WARNING\s+[^:\r\n]+:\s*(.+)$/.exec(message))) {
    klass = "warning";
    reason = logRedactionReasonOf(match[1]!);
  } else if ((match = /^git-sync config skipped\s+[^:\r\n]+:\s*(.+)$/.exec(message))) {
    klass = "config-skipped";
    reason = "config";
  } else if ((match = /^git-sync applied\s+(.+)$/.exec(message))) {
    klass = "applied";
    reason = /\(held refs:/.test(match[1]!) ? logRedactionReasonOf(match[1]!, "local-commits") : "other";
  } else if ((match = /^git-shadow disagree\s+[^:\r\n]+:\s*plane=(\S+) shadow=(\S+) refs=\d+$/.exec(message))) {
    // #832 shadow mode. Both verdict classes are closed enums, so the pair is
    // safe to keep; the repo path between them is not, and is dropped with
    // every other local name.
    klass = `shadow plane=${match[1]} shadow=${match[2]}`;
    reason = "other";
  } else if ((match = /^git-sync removed\s+(.+)$/.exec(message))) {
    klass = "removed";
    reason = "other";
  } else if (/^git-sync: captured \d+(?: \(.+\))? · carried \d+ · skipped \d+(?: \(.*\))? · deferred \d+(?: \(.*\))? · removed \d+(?: \(.*\))?$/.test(message)) {
    klass = "summary";
    reason = "other";
  } else {
    return undefined;
  }

  const key = `git-sync ${klass} reason=${reason} age=${age}`;
  return { text: key, key };
}

/** Redact local Git forensics before diagnostics leave the machine. Git-family
 * lines are fail-closed: recognized forms become closed enums; all others and
 * any physical continuation of a timestamped Git message are omitted. */
export function redactGitLogLines(tail: string): string {
  const rows: Array<{ key: string; text: string }> = [];
  // A raw Git error can contain arbitrary newlines, including a forged daemon
  // timestamp. Once a Git record starts there is no trustworthy delimiter left
  // in this legacy text format: retain only later structurally recognized Git
  // records (which are rewritten), and drop all ordinary physical lines.
  let afterGitFamily = false;
  for (const line of tail.split(/\r?\n/)) {
    const stamped = /^(\d{4}-\d\d-\d\dT\S+Z)\s+(.*)$/.exec(line);
    const message = stamped ? stamped[2]! : line;
    const isGitFamily = message.startsWith("git-sync ") || message.startsWith("git-sync:")
      || message.startsWith("git deferred") || message.startsWith("git-shadow ");
    const isLockFamily = message.startsWith("lock starved:");
    if (!isGitFamily && !isLockFamily) {
      if (!afterGitFamily) rows.push({ key: `raw\0${rows.length}`, text: line });
      continue;
    }
    afterGitFamily = true;
    if (isLockFamily) {
      const lock = /^lock starved: reason=(foreign|identity-drift|stale-owned|fence) age=(15m|1h|1d)$/.exec(message);
      if (lock) {
        const key = `lock starved: reason=${lock[1]} age=${lock[2]}`;
        rows.push({ key, text: key });
      }
      continue;
    }
    const classified = classifyGitLogLineForRedaction(message);
    if (classified) rows.push(classified);
  }

  const counts = new Map<string, number>();
  for (const row of rows) if (!row.key.startsWith("raw\0")) counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
  const emitted = new Set<string>();
  const output: string[] = [];
  for (const row of rows) {
    if (row.key.startsWith("raw\0")) {
      output.push(row.text);
      continue;
    }
    if (emitted.has(row.key)) continue;
    emitted.add(row.key);
    const count = counts.get(row.key) ?? 1;
    output.push(`${row.text}${count > 1 ? ` count=${count}` : ""}`);
  }
  return output.join("\n") + (tail.endsWith("\n") && output.length > 0 ? "\n" : "");
}
