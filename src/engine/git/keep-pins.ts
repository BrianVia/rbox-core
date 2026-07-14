import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { writeFileAtomic, fsyncDirectory } from "../fsutil.js";
import type { GitSection } from "../types.js";
import { cleanGitEnv, enumerateRefReflogOids, HEX40, git, repoCtx } from "./shared.js";
import { tipOwnedByIncoming } from "./reachability.js";

export { enumerateRefReflogOids } from "./shared.js";

export interface KeepPinOrigin {
  ref: string;
  episode: string;
  time: string;
  class: "human" | "tracking";
}

export type KeepPinOrigins = Record<string, KeepPinOrigin[]>;

export interface PreparedKeepPins {
  oids: string[];
  transactionLines: string[];
  sidecarPath: string;
}

export type PrepareDisplacedPinsResult =
  | ({ status: "prepared" } & PreparedKeepPins)
  | { status: "indeterminate"; oid: string; marker: string };

const pinRef = (oid: string) => `refs/rbox-local/keep/${oid}`;

export function humanDisplacementOrigin(ref: string, section: Pick<GitSection, "generatedAt">): KeepPinOrigin {
  return {
    ref,
    episode: section.generatedAt || String(Date.now()),
    time: new Date().toISOString(),
    class: "human",
  };
}

/** Commit caller-prepared recovery-pin lines together with their destructive ref
 * mutation.  Keeping this public prevents apply paths from accidentally splitting
 * the fsynced-origin -> pin+displacement transaction discipline. */
export async function runUpdateRefTransaction(repoDir: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return;
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repository unavailable while committing recovery pins");
  const inputPath = path.join(ctx.commonDir, `.rbox-pin-txn-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  await fs.writeFile(inputPath, ["start", ...lines, "prepare", "commit", ""].join("\n"));
  const input = await fs.open(inputPath, "r");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", ["-C", repoDir, "update-ref", "--stdin"], { env: cleanGitEnv(), stdio: [input.fd, "ignore", "pipe"] });
      let stderr = "";
      child.stderr!.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => code === 0 && !/\bfatal:/i.test(stderr) ? resolve() : reject(new Error(`git update-ref failed (${code}): ${stderr.trim()}`)));
    });
  } finally {
    await input.close();
    await fs.rm(inputPath, { force: true });
  }
}

function mergeOrigin(existing: KeepPinOrigin[], incoming: KeepPinOrigin): KeepPinOrigin[] {
  const next = existing.map((entry) => ({ ...entry }));
  const same = next.find((entry) => entry.ref === incoming.ref && entry.episode === incoming.episode);
  if (!same) next.push({ ...incoming });
  else if (incoming.class === "human") same.class = "human"; // r3 F7: promotion is monotonic.
  return next.sort((a, b) => `${a.ref}\0${a.episode}\0${a.time}`.localeCompare(`${b.ref}\0${b.episode}\0${b.time}`));
}

/**
 * First half of the r4 F3 protocol. Human provenance is fsynced before these
 * create-only lines are handed to a caller's destructive ref transaction. A
 * crash here leaves only harmless over-protection. The tracking-only retention
 * sweep intentionally lands with the deferred tracking lane, not this cycle.
 */
export async function prepareKeepPins(repoDir: string, oids: readonly string[], origin: KeepPinOrigin): Promise<PreparedKeepPins> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repository unavailable while preparing recovery pins");
  const unique = [...new Set(oids)];
  if (unique.some((oid) => !HEX40.test(oid))) throw new Error("invalid recovery-pin OID");
  const sidecarPath = path.join(ctx.commonDir, "rbox-keep-origins.json");
  const origins = JSON.parse(await fs.readFile(sidecarPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  })) as KeepPinOrigins;
  for (const oid of unique) origins[oid] = mergeOrigin(origins[oid] ?? [], origin);
  await writeFileAtomic(sidecarPath, `${JSON.stringify(origins, null, 2)}\n`);
  await fsyncDirectory(ctx.commonDir);

  const listed = await git(repoDir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/rbox-local/keep"]);
  const existingPins = new Map(listed.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf(" ");
    return [line.slice(0, separator), line.slice(separator + 1)] as const;
  }));
  const transactionLines: string[] = [];
  for (const oid of unique) {
    const existing = existingPins.get(pinRef(oid)) ?? "";
    if (existing === oid) continue;
    if (existing) throw new Error(`recovery pin collision at ${pinRef(oid)}`);
    transactionLines.push(`create ${pinRef(oid)} ${oid}`);
  }
  return { oids: unique, transactionLines, sidecarPath };
}

/** Convenience for a pin-only transaction; mutation planners use prepareKeepPins
 * and splice transactionLines into the SAME transaction as displacement. */
export async function pinDisplaced(repoDir: string, oids: readonly string[], origin: KeepPinOrigin): Promise<PreparedKeepPins> {
  const prepared = await prepareKeepPins(repoDir, oids, origin);
  try {
    await runUpdateRefTransaction(repoDir, prepared.transactionLines);
  } catch (error) {
    // A concurrent/retried identical content-addressed create is idempotent.
    for (const oid of prepared.oids) if (await git(repoDir, ["rev-parse", "--verify", pinRef(oid)]).catch(() => "") !== oid) throw error;
  }
  return prepared;
}

/** r1 F6: protect every reflog-only OID not in the caller's planned durable graph. */
export async function prepareDisplacedRefPins(
  repoDir: string,
  ref: string,
  plannedGraphRoots: readonly string[],
  origin: KeepPinOrigin,
): Promise<PrepareDisplacedPinsResult> {
  const displaced: string[] = [];
  // The live tip is a displacement candidate in its own right, not only the
  // reflog entries: with reflogs disabled or pruned (core.logAllRefUpdates=false,
  // fresh-materialized stores) the enumeration below is empty, and deleting the
  // ref would otherwise strand a unique tip with no refs/rbox-local/keep/* pin —
  // the quarantine bundle is defense in depth, never the protection (r1 F6).
  const liveTip = await git(repoDir, ["rev-parse", "--verify", "--quiet", ref]).catch(() => "");
  const candidates = new Set([...(HEX40.test(liveTip) ? [liveTip] : []), ...(await enumerateRefReflogOids(repoDir, ref))]);
  for (const oid of candidates) {
    const proof = await tipOwnedByIncoming(repoDir, oid, plannedGraphRoots);
    if (proof.status === "indeterminate") return { status: "indeterminate", oid, marker: proof.marker };
    if (proof.status === "unowned") displaced.push(oid);
  }
  return { status: "prepared", ...(await prepareKeepPins(repoDir, displaced, origin)) };
}

/** Include a displaced live tip even when it is absent from the ref's reflog. */
export async function prepareDisplacementPins(
  repoDir: string,
  ref: string,
  oldOid: string,
  plannedRoots: readonly string[],
  origin: KeepPinOrigin,
): Promise<PrepareDisplacedPinsResult> {
  const reflog = await prepareDisplacedRefPins(repoDir, ref, plannedRoots, origin);
  if (reflog.status === "indeterminate" || reflog.oids.includes(oldOid)) return reflog;
  const tip = await prepareKeepPins(repoDir, [oldOid], origin);
  return {
    ...reflog,
    oids: [...reflog.oids, oldOid],
    transactionLines: [...reflog.transactionLines, ...tip.transactionLines],
  };
}
