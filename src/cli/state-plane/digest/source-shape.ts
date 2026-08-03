/**
 * The `source_shape_flags_cjson` presence bits, built in ONE place for both
 * origin kinds (design 222 §M-5).
 *
 * `installGenesisLineage` used to spell this object inline, and U3's importer
 * would have spelled a second copy. The bits are read back by
 * `store/read-snapshot.ts`, which decides `manifestGitReposPresent` from
 * `lastSyncedManifest.gitRepos` — so the two copies could disagree about a fact
 * the read path trusts. One builder, two derivations.
 *
 * A leaf on purpose: the write fence and `schema/application.ts` reach it, and
 * neither may drag the semantic-digest grammar (or `bun:sqlite`) behind it.
 */
import type { SyncState } from "../../sync-state-model.js";
import { canonicalJson } from "./codecs.js";

export interface SourceShapeFlags {
  readonly stream: boolean;
  readonly stateNonce: boolean;
  readonly stateRevision: boolean;
  readonly lastSyncedManifest: {
    readonly manifestSchema: boolean;
    readonly gitRepos: boolean;
  };
}

export interface SourceShapePresence {
  readonly stream: boolean;
  readonly stateNonce: boolean;
  readonly stateRevision: boolean;
  readonly manifestSchema: boolean;
  readonly gitRepos: boolean;
}

/** The one builder. The nesting mirrors `SyncState`, because that is the shape
 * `read-snapshot.ts` navigates when it asks whether the source had a git layer. */
export function sourceShapeFlags(present: SourceShapePresence): SourceShapeFlags {
  return {
    stream: present.stream,
    stateNonce: present.stateNonce,
    stateRevision: present.stateRevision,
    lastSyncedManifest: {
      manifestSchema: present.manifestSchema,
      gitRepos: present.gitRepos,
    },
  };
}

/** Genesis has a stream and nothing else; its two optional lineage members are
 * the caller's, so they are asked rather than assumed. */
export function genesisSourceShapeFlags(
  present: Pick<SourceShapePresence, "stateNonce" | "stateRevision">,
): SourceShapeFlags {
  return sourceShapeFlags({
    stream: true,
    stateNonce: present.stateNonce,
    stateRevision: present.stateRevision,
    manifestSchema: false,
    gitRepos: false,
  });
}

/** Migration's derivation, from the legacy document exactly as parsed. `gitRepos`
 * records that the KEY was present, not that it held anything: an empty object
 * and an absent key are different sources and the read path reconstructs them
 * differently. */
export function legacySourceShapeFlags(state: SyncState): SourceShapeFlags {
  return sourceShapeFlags({
    stream: state.stream !== undefined,
    stateNonce: state.stateNonce !== undefined,
    stateRevision: state.stateRevision !== undefined,
    manifestSchema: state.lastSyncedManifest?.manifestSchema !== undefined,
    gitRepos: state.lastSyncedManifest?.gitRepos !== undefined,
  });
}

export const sourceShapeFlagsCjson = (flags: SourceShapeFlags): string => canonicalJson(flags);
