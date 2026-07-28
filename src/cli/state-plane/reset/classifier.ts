import fs from "node:fs/promises";
import { constants } from "node:fs";
import {
  inventoryResetNamespace,
  resetDbArtifacts,
  type ResetNamespaceInventory,
} from "../../reset-namespace-inventory.js";
import { readSqliteAuthorityId } from "./lifecycle.js";
import { sqliteResetPaths } from "./artifacts.js";

export type SqliteResetPredecodeRow =
  | { kind: "W2"; inventory: ResetNamespaceInventory }
  | { kind: "decode-journal"; inventory: ResetNamespaceInventory; journalIdentity: string }
  | { kind: "W1"; inventory: ResetNamespaceInventory }
  | { kind: "W3"; inventory: ResetNamespaceInventory }
  | { kind: "steady"; inventory: ResetNamespaceInventory }
  | { kind: "halt"; code: SqliteResetHaltCode; inventory: ResetNamespaceInventory };

export type SqliteResetHaltCode =
  | "RESET_LEGACY_ARTIFACT_INVALID"
  | "RESET_ACTIVE_ARTIFACT_INVALID"
  | "RESET_ORPHAN_ARTIFACT_INVALID";

async function journalIdentity(root: string): Promise<"absent" | string> {
  const file = sqliteResetPaths.journal(root);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    throw error;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new Error("standing reset journal is not a regular no-follow file");
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } finally {
    await handle.close();
  }
}

/**
 * Inventory-first half of the SQLite reset classifier. This is the only
 * function allowed to decide whether a journal may be decoded.
 */
export async function classifySqliteResetPredecode(root: string): Promise<SqliteResetPredecodeRow> {
  await readSqliteAuthorityId(root);
  const inventory = await inventoryResetNamespace(root);
  const journal = await journalIdentity(root);
  const artifacts = resetDbArtifacts(inventory);
  const nonS0 = artifacts.some((artifact) => artifact.sidecarVector !== "S0");

  // Standing-journal sidecar precedence is absolute: neither malformed
  // journals nor legacy-other leaves may be interpreted first.
  if (journal !== "absent" && nonS0) return { kind: "W2", inventory };

  if (inventory.legacyCandidates.some((leaf) => leaf.status === "legacy-other")
    || inventory.legacyArchives.some((leaf) => leaf.status === "legacy-other")) {
    return { kind: "halt", code: "RESET_LEGACY_ARTIFACT_INVALID", inventory };
  }

  if (journal !== "absent") {
    return { kind: "decode-journal", inventory, journalIdentity: journal };
  }

  const candidateOrArchive = [...inventory.candidates, ...inventory.archives];
  const orphanSidecar = candidateOrArchive.some((artifact) => artifact.sidecarVector !== "S0");
  if (orphanSidecar) {
    if (inventory.active.main === "regular" && inventory.active.sidecarVector === "S0") {
      return { kind: "W3", inventory };
    }
    return { kind: "halt", code: "RESET_ORPHAN_ARTIFACT_INVALID", inventory };
  }

  if (inventory.active.main !== "regular") {
    return { kind: "halt", code: "RESET_ACTIVE_ARTIFACT_INVALID", inventory };
  }
  if (inventory.active.sidecarVector === "SW") return { kind: "W1", inventory };
  if (inventory.active.sidecarVector !== "S0") {
    return { kind: "halt", code: "RESET_ACTIVE_ARTIFACT_INVALID", inventory };
  }
  return { kind: "steady", inventory };
}

export class ResetOrphanArtifactHalt extends Error {
  readonly code = "RESET_ORPHAN_ARTIFACT_HALT";
  constructor(readonly inventory: ResetNamespaceInventory) {
    super("SQLite reset halted: an orphan candidate/archive sidecar has no standing journal");
    this.name = "ResetOrphanArtifactHalt";
  }
}
