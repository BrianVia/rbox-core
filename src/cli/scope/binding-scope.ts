/**
 * The design-212 seal: is THIS binding scoped, and may it publish?
 *
 * Scope makes a binding structurally incapable of publishing. That property is only
 * as trustworthy as the reading of it, so "unscoped" requires a POSITIVE reading of
 * no-scope from an intact binding record (§3.1b layer 4). The binding record
 * (`<root>/.rbox/workspace.json`) is CANONICAL; the design-211 registry row is a
 * redundant witness whose only power is to escalate — it can prove that scope once
 * existed here, never that it did not. A witness that disagrees with an intact
 * binding record halts the binding rather than demoting it to unscoped semantics.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { bindingRegistryPath } from "../rbox-paths.js";
import { loadConfigIfPresent, type WorkspaceConfig } from "../workspace-config.js";
import { validateScopePrefixes } from "./scope-record.js";

/**
 * The witness half of the registry, read DIRECTLY rather than through
 * `binding-registry.ts`. That module unions in the daemon desired-state rows and so
 * pulls in the autostart/daemon-control graph — which in turn needs this seal. A
 * derived row could not attest to scope anyway: only a persisted entry can.
 */
type ScopeWitness = { workspaceId: string; scope?: string[]; corrupt?: true };

async function readScopeWitness(root: string): Promise<ScopeWitness | undefined> {
  let parsed: { entries?: Array<{ root?: unknown; workspaceId?: unknown; scope?: unknown }> };
  try {
    parsed = JSON.parse(await fsp.readFile(bindingRegistryPath(), "utf8")) as typeof parsed;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed?.entries)) return undefined;
  for (const entry of parsed.entries) {
    if (typeof entry?.root !== "string" || path.resolve(entry.root) !== root) continue;
    if (typeof entry.workspaceId !== "string" || entry.workspaceId.length === 0) continue;
    if (entry.scope === undefined) return { workspaceId: entry.workspaceId };
    // A scope field that is PRESENT but unreadable is damage, never absence: reading
    // it as "no scope" is precisely the demotion this witness exists to prevent.
    const usable = Array.isArray(entry.scope) && entry.scope.length > 0 && entry.scope.every((v) => typeof v === "string");
    return usable
      ? { workspaceId: entry.workspaceId, scope: entry.scope as string[] }
      : { workspaceId: entry.workspaceId, corrupt: true };
  }
  return undefined;
}

/** The two ways the seal itself cannot be read. Both stop the binding entirely. */
export type ScopeSealFailure = "binding-record-unreadable" | "scope-witness-disagreement";

export type ScopeHaltCondition = "scoped-binding-cannot-publish" | ScopeSealFailure;

export type BindingScope =
  | { kind: "unscoped" }
  | { kind: "scoped"; prefixes: readonly string[]; generation: number }
  | { kind: "halted"; condition: ScopeSealFailure; message: string };

/** A refusal named by its condition, so callers and tests never have to infer the
 *  class from prose. */
export class ScopedBindingRefusal extends Error {
  constructor(readonly condition: ScopeHaltCondition, message: string) {
    super(message);
    this.name = "ScopedBindingRefusal";
  }
}

const HALT_MESSAGE = {
  "binding-record-unreadable":
    "this folder's rbox binding record is missing or unreadable, and this machine remembers it as a partial (scoped) copy. "
    + "Syncing is paused so a partial copy is never mistaken for the whole workspace. "
    + "Restore .rbox/workspace.json, or run `rbox untrack` here and set the folder up again.",
  "scope-witness-disagreement":
    "this folder's rbox binding record no longer lists the folders it was set up to sync, but this machine still remembers them. "
    + "Syncing is paused until the two agree — re-run `rbox include add <folder>` to restate them, or `rbox untrack` and set the folder up again.",
} as const satisfies Record<ScopeSealFailure, string>;

const halt = (condition: ScopeSealFailure): BindingScope =>
  ({ kind: "halted", condition, message: HALT_MESSAGE[condition] });

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** What a binding record claims about scope. "unreadable" is the PRESENT-but-broken
 *  reading, never absence — collapsing the two is the demotion this seal prevents. */
type DeclaredScope =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "declared"; prefixes: readonly string[] };

/** Normalize what a binding record claims. An unparseable scope field is treated
 *  as PRESENT-but-broken, never as absent. */
function declaredScope(cfg: WorkspaceConfig): DeclaredScope {
  if (cfg.scope === undefined) return { kind: "absent" };
  if (!Array.isArray(cfg.scope) || cfg.scope.length === 0) return { kind: "unreadable" };
  const validated = validateScopePrefixes(cfg.scope);
  return validated.ok ? { kind: "declared", prefixes: validated.prefixes } : { kind: "unreadable" };
}

/**
 * Resolve the seal for `root`. BOTH witnesses are re-read every time, deliberately:
 * a caller's config snapshot was taken before the operation began, and the whole
 * point of this check is to notice the binding record being deleted, replaced, or
 * corrupted in the meantime. Two small file reads are cheap next to what a wrong
 * answer costs.
 */
export async function resolveBindingScope(root: string): Promise<BindingScope> {
  const abs = path.resolve(root);
  const record = await loadConfigIfPresent(abs).catch(() => undefined);
  const witness = await readScopeWitness(abs).catch(() => undefined);
  const witnessScope = witness?.scope;
  if (witness?.corrupt) return halt("scope-witness-disagreement");

  if (record === undefined) {
    // No readable binding record. Only scope evidence makes this a halt: a plain
    // untracked directory must keep failing the way it always has.
    if (witnessScope?.length) return halt("binding-record-unreadable");
    return { kind: "unscoped" };
  }

  const declared = declaredScope(record);
  if (declared.kind === "unreadable") return halt("binding-record-unreadable");
  if (declared.kind === "declared") {
    if (witnessScope && !sameSet(witnessScope, declared.prefixes)) return halt("scope-witness-disagreement");
    return { kind: "scoped", prefixes: declared.prefixes, generation: record.scopeGeneration ?? 0 };
  }
  // The record positively says "no scope", and a scope-bearing row contradicts it.
  // A genuine rebind rewrites that row through the authoritative writer and drops
  // the scope with it, so a surviving one means the record changed outside rbox —
  // regardless of which workspace id the row names.
  if (witnessScope?.length) return halt("scope-witness-disagreement");
  return { kind: "unscoped" };
}

/** Throw when the binding is halted. Every scope-aware entry point runs this before
 *  reading or writing anything. */
export function assertBindingUsable(seal: BindingScope): void {
  if (seal.kind === "halted") throw new ScopedBindingRefusal(seal.condition, seal.message);
}

export const scopedPublicationRefusal = (prefixes: readonly string[]): ScopedBindingRefusal =>
  new ScopedBindingRefusal(
    "scoped-binding-cannot-publish",
    `this folder syncs only ${prefixes.join(", ")}, so it can receive changes but never send them. `
      + "Publish from a machine that syncs the whole workspace; push code out of here with git.",
  );

/**
 * §3.1b layer 2 — command admission. Refuses BEFORE the command's own scan,
 * manifest read, or historical apply, with copy that names the remedy. The
 * `pushManifest` chokepoint would also catch these, but only after the command had
 * already read (and, for `recover`, rewritten) the tree.
 */
export async function assertCommandAllowedOnScopedBinding(
  root: string,
  verb: "push" | "recover" | "purge" | "resolve",
): Promise<void> {
  const seal = await resolveBindingScope(root);
  assertBindingUsable(seal);
  if (seal.kind !== "scoped") return;
  const why = `this folder syncs only ${seal.prefixes.join(", ")}, so it holds part of the workspace and can never send changes back.`;
  const remedy = {
    push: "Nothing to do here — this copy only receives. Push from a machine that syncs the whole workspace.",
    recover: "Run `rbox recover` on a machine that syncs the whole workspace; this copy picks up the result on its next sync.",
    purge: "Change ignore rules on a machine that syncs the whole workspace.",
    resolve: "Resolve this on a machine that syncs the whole workspace.",
  }[verb];
  throw new ScopedBindingRefusal("scoped-binding-cannot-publish", `${why} ${remedy}`);
}

/**
 * The §3.1b layer-1 chokepoint. Runs BEFORE receipt reconciliation, scan, git
 * planning, upload, or repair — every indirect publication entrance (ignore purge,
 * git keep-mine, recover's repair-publish, chain repair) passes through here.
 */
export async function assertMayPublish(root: string): Promise<void> {
  const seal = await resolveBindingScope(root);
  assertBindingUsable(seal);
  if (seal.kind === "scoped") throw scopedPublicationRefusal(seal.prefixes);
}
