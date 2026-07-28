/**
 * `rbox scope` — show, widen, or narrow the folders THIS machine syncs
 * (design 212 §3.1). Every verb has a non-interactive twin: `--json` renders the
 * same facts, and nothing here prompts.
 */
import { emitJson } from "../json.js";
import { loadState } from "../sync-state-store.js";
import { style } from "../style.js";
import { loadConfig, syncStreamId } from "../workspace-config.js";
import { resolveBindingScope, assertBindingUsable } from "./binding-scope.js";
import { ScopeProjection } from "./projection.js";
import { readScopeFindings } from "./rule-authority.js";
import { parseScopeFlag, scopeSplitsRepo, validateScopePrefixes } from "./scope-record.js";
import { resumeScopeIntent, runScopeTransition, type ScopeTransactionDeps } from "./scope-transaction.js";

export const SCOPE_USAGE = "usage: rbox scope [add <folder>… | remove <folder>…] [--json]";

interface ScopeShowRow {
  prefix: string;
  files: number;
  repos: number;
}

export async function scopeCmd(
  root: string,
  sub: string | undefined,
  args: readonly string[],
  opts: { json?: boolean } = {},
  deps: ScopeTransactionDeps = {},
): Promise<void> {
  // Any invocation finishes an interrupted edit first — a half-applied scope must
  // never be the state a user is asked to reason about.
  await resumeScopeIntent(root, deps);
  if (sub === undefined) return showScope(root, opts);
  if (sub !== "add" && sub !== "remove") throw new Error(SCOPE_USAGE);
  const requested = args.flatMap((arg) => parseScopeFlag(arg));
  if (requested.length === 0) throw new Error(SCOPE_USAGE);
  return editScope(root, sub, requested, opts, deps);
}

async function showScope(root: string, opts: { json?: boolean }): Promise<void> {
  const seal = await resolveBindingScope(root);
  assertBindingUsable(seal);
  if (seal.kind !== "scoped") {
    if (opts.json) {
      emitJson({ scoped: false, prefixes: [], mode: "read-write" });
      return;
    }
    console.log("this machine syncs the whole workspace.");
    console.log(style.dim("sync only part of it:  rbox scope add <folder>"));
    return;
  }
  const cfg = await loadConfig(root);
  const state = await loadState(root, syncStreamId(cfg));
  const projection = new ScopeProjection(seal.prefixes, Object.keys(state.lastSyncedManifest.gitRepos ?? {}));
  const rows: ScopeShowRow[] = seal.prefixes.map((prefix) => ({
    prefix,
    files: state.lastSyncedManifest.files.filter((entry) => entry.path === prefix || entry.path.startsWith(`${prefix}/`)).length,
    repos: Object.keys(state.lastSyncedManifest.gitRepos ?? {}).filter((key) => key === prefix || key.startsWith(`${prefix}/`)).length,
  }));
  const findings = await readScopeFindings(root);
  if (opts.json) {
    emitJson({
      scoped: true,
      mode: "pull-only",
      generation: seal.generation,
      prefixes: rows,
      straddlingRepos: projection.straddling,
      ruleFileDivergence: findings?.ruleFileDivergence ?? [],
    });
    return;
  }
  console.log(`${style.bold("this machine syncs")} ${style.dim("(receive-only)")}`);
  for (const row of rows) {
    console.log(`  ${style.cyan(row.prefix)}  ${style.dim(`${row.files} file${row.files === 1 ? "" : "s"}, ${row.repos} repo${row.repos === 1 ? "" : "s"}`)}`);
  }
  for (const repo of projection.straddling) {
    console.log(`  ${style.sym.warn} ${style.yellow(repo)} is a repository that crosses these folders — it is left untouched until the scope covers all of it`);
  }
  for (const rule of findings?.ruleFileDivergence ?? []) {
    console.log(`  ${style.sym.warn} ${style.yellow(rule)} was edited here and has been restored from the workspace — change ignore rules on a machine that syncs everything`);
  }
  console.log(style.dim("add a folder:  rbox scope add <folder>   remove one:  rbox scope remove <folder>"));
}

async function editScope(
  root: string,
  sub: "add" | "remove",
  requested: string[],
  opts: { json?: boolean },
  deps: ScopeTransactionDeps,
): Promise<void> {
  const seal = await resolveBindingScope(root);
  assertBindingUsable(seal);
  const accepted = seal.kind === "scoped" ? [...seal.prefixes] : [];
  const validatedRequest = validateScopePrefixes(requested);
  if (!validatedRequest.ok) throw new Error(validatedRequest.error);

  const target = sub === "add"
    ? [...new Set([...accepted, ...validatedRequest.prefixes])]
    : accepted.filter((prefix) => !validatedRequest.prefixes.includes(prefix));

  if (sub === "remove") {
    const unknown = validatedRequest.prefixes.filter((prefix) => !accepted.includes(prefix));
    if (unknown.length > 0) throw new Error(`this machine does not sync ${unknown.join(", ")} — run \`rbox scope\` to see what it does sync`);
    if (target.length === 0) {
      throw new Error("that would leave nothing to sync — run `rbox untrack` if you want to stop syncing this folder entirely");
    }
  }

  const validated = validateScopePrefixes(target);
  if (!validated.ok) throw new Error(validated.error);
  const cfg = await loadConfig(root);
  const state = await loadState(root, syncStreamId(cfg));
  const split = scopeSplitsRepo(validated.prefixes, Object.keys(state.lastSyncedManifest.gitRepos ?? {}));
  if (split) {
    throw new Error(`'${split.prefix}' is inside the git repository '${split.repo}' — sync the whole repository instead, or a checkout here would have no history`);
  }
  if (validated.prefixes.join("\n") === accepted.join("\n")) {
    if (opts.json) emitJson({ changed: false, prefixes: validated.prefixes });
    else console.log("nothing to change — this machine already syncs exactly those folders.");
    return;
  }

  const result = await runScopeTransition(root, validated.prefixes, deps);
  if (opts.json) {
    emitJson({ changed: true, ...result });
    return;
  }
  console.log(`${style.bold("now syncing")}: ${validated.prefixes.map((p) => style.cyan(p)).join(", ")}`);
  if (result.pruned.length > 0) {
    console.log(`${result.pruned.join(", ")} moved to the local trash — undo with ${style.cyan("rbox trash restore <path>")}`);
  }
  console.log(result.daemonRestarted
    ? style.dim("background sync restarted; new folders arrive shortly")
    : style.dim("run `rbox sync` to fetch the new folders"));
}
