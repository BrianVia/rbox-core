/** What a transition row and a transition stage must prove before either is
 * admitted. Kept apart from the builder so the rules can be read — and reused by
 * the sealed reader's re-admission — without the SQLite plumbing around them. */
import { canonicalStageBinding, sameStageBinding, type SourceStageBinding } from "../digest/repo-transition-v1.js";
import { canonicalJson } from "../digest/codecs.js";
import { MigrationImporterCapabilityError, ProoflessBaseError } from "../errors.js";
import type { TransitionEvidenceBindings, TransitionInput } from "./transition-stages.js";

declare const migrationImporterCapabilityBrand: unique symbol;
/**
 * The right to CREATE a migration-tagged transition stage — the tag that makes
 * blanket `migration` BASE authority admissible on re-admission, and therefore
 * the thing that has to be unforgeable on the SQLite plane (a persisted proof
 * loses its brand to the canonical-JSON round trip; the tag survives sealing).
 */
export interface MigrationImporterCapability {
  readonly [migrationImporterCapabilityBrand]: true;
}

/**
 * The capability IS this object — not its shape, not its type, not membership in
 * a registry. It is module-private, never exported, never returned by anything,
 * and never handed to a registrar, so there is no value to forge and no mint to
 * call. Validation below is `===`, so a look-alike is simply a different object.
 *
 * The previous shape kept a `WeakSet` behind an exported `register` function.
 * That was a runtime mint: a TypeScript brand constrains ordinary structural
 * assignability but says nothing to a `as never` caller, so registering a forged
 * literal admitted it. Identity has no such surface.
 */
const MIGRATION_IMPORTER = Object.freeze({}) as unknown as MigrationImporterCapability;

/**
 * Run `work` as the state-plane migration importer.
 *
 * The capability exists only as this callback's argument. This is a scope you
 * enter, not a token you are issued: nothing here returns it, and nothing
 * accepts it for safekeeping. Entering the scope is deliberately open — the
 * bound facade in `state-plane/reset/owner.ts` is equally callable — because
 * what has to be impossible is MANUFACTURING the capability, so that the only
 * code able to tag a stage is code that came through this function.
 */
export function withMigrationImporter<T>(run: (capability: MigrationImporterCapability) => T): T {
  return run(MIGRATION_IMPORTER);
}

/**
 * The stage gate's check. It compares and nothing else: it cannot produce the
 * capability, cannot store one, and cannot be talked into widening what counts
 * as one. Exported only because the const stays private to this module.
 */
export function assertMigrationImporter(value: unknown): asserts value is MigrationImporterCapability {
  if (value !== MIGRATION_IMPORTER) {
    throw new MigrationImporterCapabilityError(
      value === undefined ? "no capability was presented" : "the value presented is not the migration importer",
    );
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
