import {
  readRepoIdentityV1,
  repositoryIdentityHash,
} from "../engine/git/repo-lineage.js";
import { gitRaw } from "../engine/git/shared.js";
import { ResetCorruptionError } from "./reset-io.js";
import type { PrefixDisposition } from "./reset-journal-classifier.js";
import type { ResetZEntry } from "./reset-z.js";

const corruption = (message: string): ResetCorruptionError => new ResetCorruptionError(message);

async function readRef(entry: ResetZEntry, ref: string): Promise<string | undefined> {
  try {
    return (await gitRaw(entry.repositoryIdentity.commonDirReal, ["rev-parse", "--verify", "--quiet", ref])).trim();
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return undefined;
    throw error;
  }
}

async function verifyIdentity(entry: ResetZEntry): Promise<void> {
  const current = await readRepoIdentityV1(entry.repositoryIdentity.relPath, entry.repositoryIdentity.kind, entry.repositoryIdentity);
  if (repositoryIdentityHash(current) !== entry.repositoryIdentityHash) throw corruption("repository incarnation changed");
}

function prefixDisposition(values: readonly boolean[]): PrefixDisposition {
  let count = 0;
  while (count < values.length && values[count]) count++;
  return { kind: values.slice(count).some(Boolean) ? "other" : "prefix", count, total: values.length };
}

export async function observeResetRefs(entries: readonly ResetZEntry[]): Promise<{
  recovery: PrefixDisposition;
  activeGroups: PrefixDisposition;
}> {
  const recoveryPresent: boolean[] = [];
  for (const entry of entries) {
    await verifyIdentity(entry);
    const value = await readRef(entry, entry.recoveryRef);
    if (value !== undefined && value !== entry.targetOid) {
      return { recovery: { kind: "other", count: 0, total: entries.length }, activeGroups: { kind: "other", count: 0, total: 0 } };
    }
    recoveryPresent.push(value === entry.targetOid);
  }
  const groups = new Map<string, ResetZEntry[]>();
  for (const entry of entries) groups.set(entry.repositoryIdentity.commonDirReal, [...(groups.get(entry.repositoryIdentity.commonDirReal) ?? []), entry]);
  const retired: boolean[] = [];
  for (const commonDir of [...groups.keys()].sort()) {
    const dispositions: boolean[] = [];
    for (const entry of groups.get(commonDir)!) {
      const value = await readRef(entry, entry.activeRef);
      if (value !== undefined && value !== entry.targetOid) {
        return { recovery: prefixDisposition(recoveryPresent), activeGroups: { kind: "other", count: 0, total: groups.size } };
      }
      dispositions.push(value === undefined);
    }
    if (new Set(dispositions).size > 1) {
      return { recovery: prefixDisposition(recoveryPresent), activeGroups: { kind: "other", count: 0, total: groups.size } };
    }
    retired.push(dispositions[0] ?? false);
  }
  return { recovery: prefixDisposition(recoveryPresent), activeGroups: prefixDisposition(retired) };
}

export async function exactResetRecoveryRefs(entries: readonly ResetZEntry[]): Promise<ResetZEntry[]> {
  const existing: ResetZEntry[] = [];
  for (const entry of entries) {
    await verifyIdentity(entry);
    const value = await readRef(entry, entry.recoveryRef);
    if (value !== undefined && value !== entry.targetOid) throw corruption(`wrong recovery Z target ${entry.recoveryRef}`);
    if (value === entry.targetOid) existing.push(entry);
  }
  return existing;
}

export async function deleteExactResetRecoveryRef(entry: ResetZEntry): Promise<void> {
  await verifyIdentity(entry);
  await gitRaw(entry.repositoryIdentity.commonDirReal, ["update-ref", "-d", entry.recoveryRef, entry.targetOid]);
}

export async function createResetRecoveryRefs(
  entries: readonly ResetZEntry[],
  start: number,
  crashAt?: (point: string) => void | Promise<void>,
): Promise<void> {
  for (let index = start; index < entries.length; index++) {
    const entry = entries[index]!;
    await verifyIdentity(entry);
    if (await readRef(entry, entry.activeRef) !== entry.targetOid) throw corruption(`active Z changed ${entry.activeRef}`);
    const recovery = await readRef(entry, entry.recoveryRef);
    if (recovery !== undefined && recovery !== entry.targetOid) throw corruption(`wrong recovery Z target ${entry.recoveryRef}`);
    if (recovery === undefined) await gitRaw(entry.repositoryIdentity.commonDirReal, ["update-ref", entry.recoveryRef, entry.targetOid, ""]);
    await crashAt?.(`after-recovery-ref-${index + 1}`);
  }
}

export async function retireResetActiveGroups(
  entries: readonly ResetZEntry[],
  start: number,
  crashAt?: (point: string) => void | Promise<void>,
): Promise<void> {
  const groups = new Map<string, ResetZEntry[]>();
  for (const entry of entries) groups.set(entry.repositoryIdentity.commonDirReal, [...(groups.get(entry.repositoryIdentity.commonDirReal) ?? []), entry]);
  const ordered = [...groups.keys()].sort();
  for (let index = start; index < ordered.length; index++) {
    const commonDir = ordered[index]!;
    const group = groups.get(commonDir)!.sort((a, b) => a.activeRef.localeCompare(b.activeRef));
    for (const entry of group) {
      await verifyIdentity(entry);
      if (await readRef(entry, entry.recoveryRef) !== entry.targetOid) throw corruption(`wrong recovery Z target ${entry.recoveryRef}`);
      const active = await readRef(entry, entry.activeRef);
      if (active !== undefined && active !== entry.targetOid) throw corruption(`wrong active Z target ${entry.activeRef}`);
    }
    const present = await Promise.all(group.map(async (entry) => (await readRef(entry, entry.activeRef)) === entry.targetOid));
    if (present.some(Boolean) && !present.every(Boolean)) throw corruption(`physically impossible mixed Z retirement in ${commonDir}`);
    if (present.every(Boolean)) {
      const stdin = group.map((entry) => `delete ${entry.activeRef} ${entry.targetOid}`).join("\n") + "\n";
      await gitRaw(commonDir, ["update-ref", "--stdin"], { stdin });
    }
    await crashAt?.(`after-active-group-${index + 1}`);
  }
}
