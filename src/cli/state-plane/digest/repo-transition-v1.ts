import type { LineageSnapshot } from "../ports.js";
import { canonicalJson, domainHash } from "./codecs.js";

declare const transitionDigestBrand: unique symbol;
export type RepoTransitionDigest = string & { readonly [transitionDigestBrand]: "repo-transition-v1" };

/** The exact identity of one already-sealed source stage. Nothing else may bind
 * a transition to its input: a name or a stage id alone is forgeable. */
export interface SourceStageBinding {
  stageId: string;
  logicalDigest: string;
  physicalSha256: string;
}

export function canonicalStageBinding(binding: SourceStageBinding): string {
  return canonicalJson({
    stageId: binding.stageId,
    logicalDigest: binding.logicalDigest,
    physicalSha256: binding.physicalSha256,
  });
}

export function sameStageBinding(left: SourceStageBinding, right: SourceStageBinding): boolean {
  return canonicalStageBinding(left) === canonicalStageBinding(right);
}

/**
 * `repo-transition-v1`. Covers the coherent snapshot token, the ordered exact
 * source-stage refs, and per row the relPath, expected generation, complete new
 * record, base proof (with an explicit absence bit), and evidence binding.
 */
export class RepoTransitionDigestBuilder {
  readonly #hash = domainHash("repo-transition-v1");
  #rows = 0;
  #sealed = false;

  constructor(snapshotToken: LineageSnapshot, sourceStageBindings: readonly SourceStageBinding[]) {
    this.#hash.token("snapshot");
    this.#hash.token(canonicalJson(snapshotToken));
    this.#hash.token("source-stages");
    this.#hash.token(String(sourceStageBindings.length));
    for (const binding of sourceStageBindings) this.#hash.token(canonicalStageBinding(binding));
  }

  row(input: {
    relPath: string;
    expectedRepoGen: number;
    canonicalRecord: string;
    canonicalBaseProof: string | undefined;
    canonicalEvidenceBindings: string;
  }): void {
    if (this.#sealed) throw new Error("transition digest is already sealed");
    this.#hash.token("transition");
    this.#hash.token(input.relPath);
    this.#hash.token(String(input.expectedRepoGen));
    this.#hash.token(input.canonicalRecord);
    this.#hash.token(input.canonicalBaseProof === undefined ? "0" : "1");
    if (input.canonicalBaseProof !== undefined) this.#hash.token(input.canonicalBaseProof);
    this.#hash.token(input.canonicalEvidenceBindings);
    this.#rows++;
  }

  seal(): RepoTransitionDigest {
    if (this.#sealed) throw new Error("transition digest is already sealed");
    this.#hash.token("rows");
    this.#hash.token(String(this.#rows));
    this.#sealed = true;
    return this.#hash.digest() as RepoTransitionDigest;
  }

  get rows(): number {
    return this.#rows;
  }
}
