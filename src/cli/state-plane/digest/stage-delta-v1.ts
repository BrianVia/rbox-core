import type { DeltaBinding } from "../../sync-state-delta.js";
import type { ManifestHeader, Plane } from "../ports.js";
import { canonicalJson, domainHash } from "./codecs.js";

declare const deltaDigestBrand: unique symbol;
export type StageDeltaLogicalDigest = string & { readonly [deltaDigestBrand]: "stage-delta-v1" };

/** Every count a sealed delta commits to: how many ops it carries, by kind, and
 * how many files the plane must hold once they are applied. */
export interface DeltaCounts {
  upserts: number;
  deletes: number;
  resultFiles: number;
}

/**
 * `stage-delta-v1`. Length-framed over: stage id, plane, the complete header, the
 * predecessor binding, every op in strictly ascending path order, and the sealed
 * counts including `resultFiles`.
 *
 * The builder is fed the SAME canonical bytes the delta rows store, so a consumer
 * streaming those rows recomputes it bit-identically or the artifact is refused.
 */
export class StageDeltaDigestBuilder {
  readonly #hash = domainHash("stage-delta-v1");
  #upserts = 0;
  #deletes = 0;
  #sealed = false;

  constructor(stageId: string, plane: Plane, header: ManifestHeader, binding: DeltaBinding) {
    this.#hash.token("stage-id");
    this.#hash.token(stageId);
    this.#hash.token("plane");
    this.#hash.token(plane);
    this.#hash.token("header");
    this.#hash.token(canonicalJson(header));
    this.#hash.token("binding");
    this.#hash.token(canonicalJson({ nonce: binding.nonce, stateRevision: binding.stateRevision }));
  }

  upsert(path: string, canonicalEntry: string): void {
    this.#assertOpen();
    this.#hash.token("upsert");
    this.#hash.token(path);
    this.#hash.token(canonicalEntry);
    this.#upserts++;
  }

  delete(path: string): void {
    this.#assertOpen();
    this.#hash.token("delete");
    this.#hash.token(path);
    this.#deletes++;
  }

  get counts(): Pick<DeltaCounts, "upserts" | "deletes"> {
    return { upserts: this.#upserts, deletes: this.#deletes };
  }

  seal(expectedCounts: DeltaCounts): StageDeltaLogicalDigest {
    this.#assertOpen();
    if (expectedCounts.upserts !== this.#upserts || expectedCounts.deletes !== this.#deletes) {
      throw new TypeError(
        `delta counts ${this.#upserts}/${this.#deletes} do not match expected ${expectedCounts.upserts}/${expectedCounts.deletes}`,
      );
    }
    if (!Number.isSafeInteger(expectedCounts.resultFiles) || expectedCounts.resultFiles < 0) {
      throw new TypeError("delta resultFiles must be a nonnegative integer");
    }
    this.#hash.token("counts");
    this.#hash.token(canonicalJson(expectedCounts));
    this.#sealed = true;
    return this.#hash.digest() as StageDeltaLogicalDigest;
  }

  #assertOpen(): void {
    if (this.#sealed) throw new Error("delta digest is already sealed");
  }
}
