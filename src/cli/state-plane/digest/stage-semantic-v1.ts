import type { GitSectionRole, ManifestHeader, Plane } from "../ports.js";
import { canonicalJson, domainHash } from "./codecs.js";

declare const stageDigestBrand: unique symbol;
export type StageLogicalDigest = string & { readonly [stageDigestBrand]: "stage-semantic-v1" };

export interface StageCounts {
  files: number;
  gitSections: number;
}

export const STAGE_GIT_ROLES = ["meta-wire", "manifest-projection"] as const;

/**
 * `stage-semantic-v1`. Length-framed over: stage id, plane, the complete header
 * (known fields, optional-presence bits, extras), expected counts, every ordered
 * complete FileEntry, and every ordered `(role,relPath,complete GitSection)`
 * including empty-versus-absent roles.
 *
 * The builder is fed the SAME canonical bytes the stage rows store, so a fresh
 * recomputation by a consumer streaming those rows is bit-identical or the stage
 * is refused. Callers never supply the digest.
 */
export class StageDigestBuilder {
  readonly #hash = domainHash("stage-semantic-v1");
  readonly #declaredRoles = new Set<GitSectionRole>();
  #files = 0;
  #gitSections = 0;
  #sealed = false;

  constructor(stageId: string, plane: Plane, header: ManifestHeader) {
    this.#hash.token("stage-id");
    this.#hash.token(stageId);
    this.#hash.token("plane");
    this.#hash.token(plane);
    this.#hash.token("header");
    this.#hash.token(canonicalJson(header));
  }

  file(canonicalEntry: string): void {
    this.#assertOpen();
    this.#hash.token("file");
    this.#hash.token(canonicalEntry);
    this.#files++;
  }

  /** A role that exists with zero sections is distinct from an absent role. */
  declareRole(role: GitSectionRole): void {
    this.#assertOpen();
    this.#declaredRoles.add(role);
  }

  gitSection(role: GitSectionRole, relPath: string, canonicalSection: string): void {
    this.#assertOpen();
    this.#declaredRoles.add(role);
    this.#hash.token("git-section");
    this.#hash.token(role);
    this.#hash.token(relPath);
    this.#hash.token(canonicalSection);
    this.#gitSections++;
  }

  get counts(): StageCounts {
    return { files: this.#files, gitSections: this.#gitSections };
  }

  seal(expectedCounts: StageCounts): StageLogicalDigest {
    this.#assertOpen();
    if (expectedCounts.files !== this.#files || expectedCounts.gitSections !== this.#gitSections) {
      throw new TypeError(
        `stage counts ${this.#files}/${this.#gitSections} do not match expected ${expectedCounts.files}/${expectedCounts.gitSections}`,
      );
    }
    for (const role of STAGE_GIT_ROLES) {
      this.#hash.token("role-present");
      this.#hash.token(role);
      this.#hash.token(this.#declaredRoles.has(role) ? "1" : "0");
    }
    this.#hash.token("counts");
    this.#hash.token(canonicalJson(expectedCounts));
    this.#sealed = true;
    return this.#hash.digest() as StageLogicalDigest;
  }

  #assertOpen(): void {
    if (this.#sealed) throw new Error("stage digest is already sealed");
  }
}
