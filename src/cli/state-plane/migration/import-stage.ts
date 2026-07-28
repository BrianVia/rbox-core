/**
 * The right to create a migration-tagged transition stage.
 *
 * On the SQLite plane a `RepoBaseProof` is serialized into `base_proof_cjson`
 * and reconstructed without its brand, so a minted blanket authority and a
 * forged one are indistinguishable by the time re-admission sees them. What
 * re-admission actually trusts is the STAGE'S IMPORTER TAG, which is written
 * once at creation and then bound by the seal. So the tag is the thing that has
 * to be unforgeable, and this module is where that is decided.
 *
 * `MigrationImporterCapability` is branded with a non-exported `unique symbol`
 * (`store/transition-admission.ts`), so no module can write one down. The single
 * token is minted here, registered for identity, and captured by the one entry
 * point below — never exported, never returned. That is the
 * `state-plane/reset/owner.ts` idiom: deep importers may use the bound entry
 * point but cannot mint another.
 *
 * Kept apart from `./base-proof.ts` so the leaf that `sync-state-model.ts`
 * depends on for legacy adoption never reaches into the store's import graph.
 */
import type { SourceStageBinding } from "../digest/repo-transition-v1.js";
import type { LineageSnapshot } from "../ports.js";
import {
  registerMigrationImporterCapability,
  type MigrationImporterCapability,
} from "../store/transition-admission.js";
import { beginRepoTransitionStage, type RepoTransitionStageBuilder } from "../store/transition-stages.js";

const MIGRATION_IMPORTER = Object.freeze({
  kind: "state-plane-migration-importer/v1" as const,
}) as unknown as MigrationImporterCapability;
registerMigrationImporterCapability(MIGRATION_IMPORTER);

/**
 * The only way to create a migration-tagged transition stage — the tag that lets
 * blanket `migration` BASE authority survive sealing and be re-admitted from the
 * sealed artifact. U3's JSON importer enters here; every other caller gets an
 * `engine` stage, whose rows may not name blanket authority at all.
 */
export function beginMigrationImportStage(
  directory: string,
  snapshotToken: LineageSnapshot,
  sourceStageBindings: readonly SourceStageBinding[],
  options: { stageId?: string; globalBinding?: SourceStageBinding } = {},
): RepoTransitionStageBuilder {
  return beginRepoTransitionStage(directory, snapshotToken, sourceStageBindings, {
    ...options, importer: "migration", capability: MIGRATION_IMPORTER,
  });
}
