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
async function readScopeWitness(root: string): Promise<{ workspaceId: string; scope?: string[] } | undefined> {
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
    const scope = Array.isArray(entry.scope) && entry.scope.length > 0 && entry.scope.every((v) => typeof v === "string")
      ? (entry.scope as string[])
      : undefined;
    return { workspaceId: entry.workspaceId, ...(scope === undefined ? {} : { scope }) };
  }
  return undefined;
}

export type ScopeHaltCondition =
  | "scoped-binding-cannot-publish"
  | "binding-record-unreadable"
  | "scope-witness-disagreement";

export type BindingScope =
  | { kind: "unscoped" }
  | { kind: "scoped"; prefixes: readonly string[]; generation: number }
  | { kind: "halted"; condition: ScopeHaltCondition; message: string };

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
    + "Syncing is paused until the two agree — re-run `rbox scope add <folder>` to restate them, or `rbox untrack` and set the folder up again.",
  "scoped-binding-cannot-publish": "",
} as const satisfies Record<ScopeHaltCondition, string>;

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** Normalize what a binding record claims. An unparseable scope field is treated
 *  as PRESENT-but-broken, never as absent. */
function declaredScope(cfg: Pick<WorkspaceConfig, "scope">): { present: boolean; prefixes?: string[] } {
  if (cfg.scope === undefined) return { present: false };
  if (!Array.isArray(cfg.scope) || cfg.scope.length === 0) return { present: true };
  const validated = validateScopePrefixes(cfg.scope);
  return validated.ok ? { present: true, prefixes: validated.prefixes } : { present: true };
}

/**
 * Resolve the seal for `root`. `cfg` is accepted so hot paths that already hold the
 * binding record do not re-read it; the registry witness is always re-read (it is
 * the cheap half and the whole point is to catch the record having changed).
 */
export async function resolveBindingScope(root: string, cfg?: Pick<WorkspaceConfig, "scope" | "scopeGeneration" | "remoteWorkspaceId">): Promise<BindingScope> {
  const abs = path.resolve(root);
  const record = cfg ?? await loadConfigIfPresent(abs);
  const witness = await readScopeWitness(abs).catch(() => undefined);
  const witnessScope = witness?.scope;

  if (record === undefined) {
    // No binding record at all. Only scope evidence makes this a halt: a plain
    // untracked directory must keep failing the way it always has.
    if (witnessScope?.length) {
      return { kind: "halted", condition: "binding-record-unreadable", message: HALT_MESSAGE["binding-record-unreadable"] };
    }
    return { kind: "unscoped" };
  }

  const declared = declaredScope(record);
  if (declared.present && declared.prefixes === undefined) {
    return { kind: "halted", condition: "binding-record-unreadable", message: HALT_MESSAGE["binding-record-unreadable"] };
  }
  if (declared.prefixes) {
    if (witnessScope && !sameSet(witnessScope, declared.prefixes)) {
      return { kind: "halted", condition: "scope-witness-disagreement", message: HALT_MESSAGE["scope-witness-disagreement"] };
    }
    return { kind: "scoped", prefixes: declared.prefixes, generation: record.scopeGeneration ?? 0 };
  }
  // The record positively says "no scope". Only a witness bound to the SAME binding
  // incarnation can contradict it — after a rebind the old row means nothing.
  if (witnessScope?.length && witness?.workspaceId === record.remoteWorkspaceId) {
    return { kind: "halted", condition: "scope-witness-disagreement", message: HALT_MESSAGE["scope-witness-disagreement"] };
  }
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
export async function assertMayPublish(root: string, cfg?: Parameters<typeof resolveBindingScope>[1]): Promise<void> {
  const seal = await resolveBindingScope(root, cfg);
  assertBindingUsable(seal);
  if (seal.kind === "scoped") throw scopedPublicationRefusal(seal.prefixes);
}
