/**
 * The ONE shared pre-probe scope projection (design 212 §3.2, r2 finding 4).
 *
 * Every producer — reconcile/apply, blob fetch, git apply, status, doctor, deferral
 * hygiene — filters through this object BEFORE constructing keys, candidates, or
 * collision sets. Filtering rendered copy instead would leave the probes (and the
 * damage they can do to durable sidecars) in place.
 */
import type { Manifest } from "../../engine/index.js";
import { containsPrefix, withinPrefix } from "./scope-record.js";

export type RepoRelation = "in" | "straddle" | "oos";

/** Ignore-rule files this binding must hold even when they sit outside every
 *  prefix: without them the local matcher evaluates different rules than the
 *  publisher did, and scoped/full bindings would disagree about what is synced. */
export function metadataRuleFiles(prefixes: readonly string[]): string[] {
  const files = new Set<string>([".rboxignore", ".gitignore"]);
  for (const prefix of prefixes) {
    const segments = prefix.split("/");
    // Strict ancestors only — a prefix's OWN .gitignore is in scope already.
    for (let depth = 1; depth < segments.length; depth++) {
      files.add(`${segments.slice(0, depth).join("/")}/.gitignore`);
    }
  }
  return [...files].sort();
}

export class ScopeProjection {
  readonly prefixes: readonly string[];
  /** Repo keys that CONTAIN a scope boundary. Their whole subtree is quarantined:
   *  prior file and git BASE are retained and nothing is written or fetched. */
  readonly straddling: readonly string[];
  private readonly metadata: ReadonlySet<string>;

  constructor(prefixes: readonly string[], repoKeys: Iterable<string> = []) {
    this.prefixes = [...prefixes];
    this.metadata = new Set(metadataRuleFiles(this.prefixes));
    const straddling: string[] = [];
    for (const raw of repoKeys) {
      if (this.classifyRepo(raw) === "straddle") straddling.push(raw);
    }
    this.straddling = straddling.sort();
  }

  /** Segment-aware IN / STRADDLE / OOS for one git repo key. `"."` is the workspace
   *  root itself: with any scope it always straddles. */
  classifyRepo(repoKey: string): RepoRelation {
    const key = repoKey === "." ? "" : repoKey;
    if (key === "") return "straddle";
    if (this.prefixes.some((prefix) => withinPrefix(prefix, key))) return "in";
    if (this.prefixes.some((prefix) => containsPrefix(key, prefix))) return "straddle";
    return "oos";
  }

  /** Is `rel` under a repo that crosses the scope boundary? Such paths are frozen.
   *  A repository at the workspace root crosses EVERY boundary, so it freezes the
   *  whole file plane — writing part of a repository's worktree while its history
   *  stays behind is the split this design refuses. */
  quarantined(rel: string): boolean {
    return this.straddling.some((repo) => (repo === "." ? true : withinPrefix(repo, rel)));
  }

  /** Does this binding materialize `rel`? Metadata rule files are always in. */
  includes(rel: string): boolean {
    if (this.quarantined(rel)) return false;
    if (this.metadata.has(rel)) return true;
    return this.prefixes.some((prefix) => withinPrefix(prefix, rel));
  }

  isMetadata(rel: string): boolean {
    return this.metadata.has(rel);
  }

  /** Project a manifest's FILE plane onto this scope. The git plane is projected
   *  separately (repo relations, not paths) so a straddling repo can retain BASE. */
  projectFiles(manifest: Manifest): Manifest {
    return { ...manifest, files: manifest.files.filter((entry) => this.includes(entry.path)) };
  }

  /** The set of git repo keys this binding may probe, given every key it knows. */
  probeKeys(keys: Iterable<string>): string[] {
    return [...keys].filter((key) => this.classifyRepo(key) === "in").sort();
  }

  /** Keys deliberately NOT probed — bookkeeping carry only. */
  carriedKeys(keys: Iterable<string>): string[] {
    return [...keys].filter((key) => this.classifyRepo(key) !== "in").sort();
  }

  describe(): string {
    return this.prefixes.join(", ");
  }
}

/**
 * Compose the manifest to persist as the new BASE. Out-of-scope entries carry the
 * REMOTE truth verbatim (bookkeeping — nothing local ever contradicts them, and
 * this binding cannot publish). Quarantined entries keep the PRIOR base: a repo
 * that just started crossing the boundary must not have its file BASE advance past
 * a tree we deliberately did not write (r2 finding 5).
 */
export function composeScopedBase(base: Manifest, remote: Manifest, projection: ScopeProjection): Manifest {
  if (projection.straddling.length === 0) return remote;
  const retained = base.files.filter((entry) => projection.quarantined(entry.path));
  const advanced = remote.files.filter((entry) => !projection.quarantined(entry.path));
  return { ...remote, files: [...advanced, ...retained].sort((a, b) => a.path.localeCompare(b.path)) };
}

/**
 * Resolve the projection for a root, or undefined when the binding is unscoped.
 * Producers call this THEMSELVES rather than receiving it through a parameter: a
 * probe that forgot to thread the projection down would be exactly the silent
 * out-of-scope filesystem read this exists to prevent.
 */
export async function scopeProjectionFor(root: string, repoKeys: Iterable<string> = []): Promise<ScopeProjection | undefined> {
  const { assertBindingUsable, resolveBindingScope } = await import("./binding-scope.js");
  const seal = await resolveBindingScope(root);
  assertBindingUsable(seal);
  return seal.kind === "scoped" ? new ScopeProjection(seal.prefixes, repoKeys) : undefined;
}
