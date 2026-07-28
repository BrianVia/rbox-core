/** What a transition row and a transition stage must prove before either is
 * admitted. Kept apart from the builder so the rules can be read — and reused by
 * the sealed reader's re-admission — without the SQLite plumbing around them. */
import { canonicalStageBinding, sameStageBinding, type SourceStageBinding } from "../digest/repo-transition-v1.js";
import { canonicalJson } from "../digest/codecs.js";
import { MigrationImporterCapabilityError, ProoflessBaseError } from "../errors.js";
import type { TransitionEvidenceBindings, TransitionInput } from "./transition-stages.js";

declare const migrationImporterCapabilityBrand: unique symbol;
/**
 * The right to CREATE a migration-tagged transition stage.
 *
 * The brand is a non-exported `unique symbol`, so no module can write one down;
 * the sole cast that produces one is lexical to
 * `state-plane/migration/base-proof.ts`, which keeps it module-private and hands
 * it only to the entry point it binds (the `state-plane/reset/owner.ts` idiom).
 */
export interface MigrationImporterCapability {
  readonly kind: "state-plane-migration-importer/v1";
  readonly [migrationImporterCapabilityBrand]: true;
}

const MIGRATION_IMPORTERS = new WeakSet<object>();

/**
 * Teach this seam the identity of migration territory's token. This is NOT an
 * authorization decision — its argument is unforgeable without the brand, so
 * only the one lexical mint can call it. It exists because the store must not
 * import migration territory (that would close a cycle), and a WeakSet needs
 * the object, not just its type.
 */
export function registerMigrationImporterCapability(capability: MigrationImporterCapability): void {
  MIGRATION_IMPORTERS.add(capability);
}

export function assertMigrationImporterCapability(value: unknown): asserts value is MigrationImporterCapability {
  if (value === null || value === undefined || typeof value !== "object") {
    throw new MigrationImporterCapabilityError("no capability was presented");
  }
  if (!MIGRATION_IMPORTERS.has(value)) {
    throw new MigrationImporterCapabilityError("the value presented is not the minted capability");
  }
}

/** Exact-identity dedup. A duplicate would be verified twice and, worse, consumed
 * twice — leaving post-commit cleanup to delete an artifact it already removed. */
export function assertDeclaredBindings(bindings: readonly SourceStageBinding[]): void {
  const seen = new Set<string>();
  for (const binding of bindings) {
    const identity = canonicalStageBinding(binding);
    if (seen.has(identity)) {
      throw new TypeError(`source stage ${binding.stageId} is declared more than once`);
    }
    seen.add(identity);
  }
  if (new Set(bindings.map((binding) => binding.stageId)).size !== bindings.length) {
    throw new TypeError("two source stages share a stage id with different identities");
  }
}

export const canonicalEvidenceOf = (evidence: TransitionEvidenceBindings): string =>
  canonicalJson({
    sourceStages: evidence.sourceStages.map((binding) => ({
      stageId: binding.stageId, logicalDigest: binding.logicalDigest, physicalSha256: binding.physicalSha256,
    })),
  });

/**
 * The proof rule the withdrawn first implementation of this seam failed.
 *
 * A record that carries `base` or `branchBaseOrigins` is asserting new BASE
 * authority. That assertion is admitted only with an explicit `RepoBaseProof` whose
 * authority kind is a real one — the `migration` kind is a blanket authority
 * reserved for the tagged migration importer, which is why an implicit
 * `migrationRepoBaseProof()` default is not offered anywhere in this seam. Whatever
 * proof is supplied is then bound by the transition digest to this repository, its
 * expected generation, the source evidence, and the coherent snapshot token.
 */
export function assertBaseProof(
  input: Pick<TransitionInput, "relPath" | "newRecord" | "baseProof">,
  importer: "engine" | "migration",
): void {
  if (input.baseProof === undefined) {
    if (input.newRecord.base !== undefined) {
      throw new ProoflessBaseError(input.relPath, "the record introduces or changes BASE but carries no baseProof");
    }
    if (input.newRecord.branchBaseOrigins !== undefined) {
      throw new ProoflessBaseError(input.relPath, "the record carries branch base origins but no baseProof");
    }
    return;
  }
  const authority = input.baseProof.authority;
  if (!authority || typeof authority.kind !== "string") {
    throw new ProoflessBaseError(input.relPath, "baseProof has no authority kind");
  }
  if (authority.kind === "migration" && importer !== "migration") {
    throw new ProoflessBaseError(input.relPath, "implicit migration authority is reserved for the tagged migration importer");
  }
  if (!input.baseProof.lockedProof) throw new ProoflessBaseError(input.relPath, "baseProof has no lockedProof");
}

/** Admission for one row's evidence. An empty list is refused whenever the stage
 * declared any source, so a derived record can never reach the CAS unattributed. */
export function assertEvidence(
  relPath: string,
  evidence: TransitionEvidenceBindings | undefined,
  declared: readonly SourceStageBinding[],
  globalBinding?: SourceStageBinding,
): void {
  const named = evidence?.sourceStages;
  if (!Array.isArray(named)) throw new TypeError(`transition ${relPath} has no evidenceBindings.sourceStages`);
  if (declared.length === 0) {
    if (named.length > 0) throw new TypeError(`transition ${relPath} names source stages, but the stage declared none`);
    return;
  }
  if (named.length === 0) {
    throw new TypeError(`transition ${relPath} names no source stage, but this stage derives from ${declared.length}`);
  }
  for (const binding of named) {
    if (!declared.some((row) => sameStageBinding(row, binding))) {
      throw new TypeError(`transition ${relPath} names source stage ${binding.stageId}, which this stage is not bound to`);
    }
  }
  // Subset-of-declared is not enough. When a global stage exists every derived
  // record is derived from IT, so its exact identity must appear in each row —
  // otherwise a row could attribute itself to a Git-proof stage alone.
  if (globalBinding && !named.some((binding) => sameStageBinding(binding, globalBinding))) {
    throw new TypeError(`transition ${relPath} does not name the global source stage ${globalBinding.stageId}`);
  }
}
