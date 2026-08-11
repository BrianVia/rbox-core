/** CLI Adapter for the user-owned folder configuration authority. */
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { expandUserPath } from "./directory-picker.js";
import { ensureFolderAuthority } from "./folder-authority.js";
import {
  confirmFolderRegeneration,
  inspectFolderCatalog,
  prepareFolderRegeneration,
  publishFolderRegeneration,
  recordFolder,
  resolveFolderPolicy,
  snapshotPreCatalogPolicy,
} from "./folder-config.js";
import { listFolderInventory, observeFolderGeneration, type FolderInventoryRow } from "./folder-inventory.js";
import { emitJson } from "./json.js";
import { folderCatalogPath, homeDir } from "./rbox-paths.js";
import { style } from "./style.js";
import { projectFolderConfigJson } from "./folder-config-json.js";
import { loadConfigIfPresent } from "./workspace-config.js";

const REGENERATION_ATTEMPTS = 3;

export interface FolderConfigCommandOptions {
  json: boolean;
  yes: boolean;
}

export interface FolderConfigCommandDeps {
  confirm?: (prompt: string) => Promise<boolean>;
  write?: (line: string) => void;
}

function absoluteUserPath(value: string): string {
  return path.resolve(expandUserPath(value, homeDir()));
}

function policyLine(policy: ReturnType<typeof resolveFolderPolicy>): string {
  return [
    `syncGit=${policy.syncGit}`,
    `git.incremental=${policy.git.incremental}`,
    `respectGitignore=${policy.respectGitignore}`,
    `noDrift=${policy.noDrift}`,
    `trash.days=${policy.trash.days}`,
    `trash.maxBytes=${policy.trash.maxBytes}`,
  ].join(", ");
}

export function renderFolderConfig(
  state: Awaited<ReturnType<typeof ensureFolderAuthority>>,
  rows: readonly FolderInventoryRow[],
): string[] {
  const lines = [
    `${style.bold("rbox config")} — ${folderCatalogPath()}`,
    "",
    `global defaults: ${policyLine(resolveFolderPolicy(state.snapshot.catalog.globalOptions))}`,
    "",
  ];
  if (rows.length === 0) return [...lines, "no folders configured or discovered."];
  for (const row of rows) {
    const label = row.catalog?.name ?? "(not configured)";
    const detail = row.admission.kind === "admitted" ? "admitted" : `${row.admission.kind}: ${row.admission.reason}`;
    lines.push(`${row.admission.kind === "admitted" ? style.sym.ok : style.sym.warn} ${style.bold(label)} ${style.dim(row.root)}`);
    lines.push(`    ${detail}`);
    if (row.overlap) lines.push(`    overlap: ${row.overlap.kind} of ${row.overlap.of}`);
  }
  return lines;
}

async function show(options: FolderConfigCommandOptions, write: (line: string) => void): Promise<void> {
  const state = await ensureFolderAuthority();
  const inventory = await listFolderInventory(state);
  if (options.json) emitJson(projectFolderConfigJson(state, inventory.rows));
  else for (const line of renderFolderConfig(state, inventory.rows)) write(line);
}

async function add(rawPath: string, write: (line: string) => void): Promise<void> {
  const root = absoluteUserPath(rawPath);
  const state = await ensureFolderAuthority({ currentRoot: root });
  const existing = state.snapshot.folders.some((folder) => folder.normalizedPath === root);
  if (!existing) {
    const inventory = await listFolderInventory(state, { currentRoot: root });
    const target = inventory.rows.find((row) => row.root === root);
    if (target?.overlap !== undefined) {
      throw new Error(`cannot add ${root}: it physically overlaps ${target.overlap.of} (${target.overlap.kind}); existing configured overlaps remain supported`);
    }
  }
  // Only a READABLE binding contributes a policy snapshot; a corrupt
  // workspace.json must not block adding the folder (diagnosis comes after).
  const binding = await loadConfigIfPresent(root).catch(() => undefined);
  await recordFolder(root, binding === undefined ? {} : { options: snapshotPreCatalogPolicy(binding) });
  write(`${style.sym.ok} ${existing ? "already configured" : "added"} ${root}`);
}

async function interactiveConfirm(prompt: string): Promise<boolean> {
  if (!input.isTTY) throw new Error("regeneration requires confirmation; re-run with `rbox config regenerate --yes`");
  const readline = createInterface({ input, output });
  try {
    return (await readline.question(`${prompt} [y/N] `)).trim().toLowerCase() === "y";
  } finally {
    readline.close();
  }
}

async function regenerate(options: FolderConfigCommandOptions, deps: FolderConfigCommandDeps): Promise<void> {
  const write = deps.write ?? console.log;
  for (let count = 0; count < REGENERATION_ATTEMPTS; count++) {
    const state = await inspectFolderCatalog();
    const inventory = await observeFolderGeneration(state);
    const attempt = prepareFolderRegeneration(state, inventory);
    write(attempt.loss.description);
    if (attempt.loss.entries.length > 0) {
      write("Affected entries:");
      for (const entry of attempt.loss.entries) write(`  ${entry.name}: ${entry.path}`);
    }
    if (attempt.skipped.length > 0) {
      write("Bindings that will be omitted:");
      for (const skipped of attempt.skipped) write(`  skipped ${skipped.root}: ${skipped.reason}`);
    }
    const accepted = options.yes || await (deps.confirm ?? interactiveConfirm)("Replace the current rbox folder configuration?");
    if (!accepted) {
      write("Regeneration cancelled — nothing changed.");
      return;
    }
    const result = await publishFolderRegeneration(attempt, confirmFolderRegeneration(attempt));
    if (result.kind === "catalog-changed") {
      write("The folder configuration changed while confirming; reviewing the latest state again.");
      continue;
    }
    write(`${style.sym.ok} regenerated ${folderCatalogPath()}`);
    return;
  }
  throw new Error("rbox folder configuration kept changing during regeneration; stop concurrent edits and retry");
}

export async function folderConfigCmd(
  positional: string[],
  options: FolderConfigCommandOptions,
  deps: FolderConfigCommandDeps = {},
): Promise<void> {
  const [subcommand, argument, ...extra] = positional;
  const write = deps.write ?? console.log;
  if (subcommand === undefined) return show(options, write);
  if (subcommand === "add" && argument !== undefined && extra.length === 0 && !options.json && !options.yes) return add(argument, write);
  if (subcommand === "regenerate" && argument === undefined && extra.length === 0 && !options.json) return regenerate(options, deps);
  if (subcommand === "repair" && argument !== undefined && extra.length === 0 && !options.json && !options.yes) {
    const { repairFolderMove } = await import("./folder-repair-cmd.js");
    await repairFolderMove(absoluteUserPath(argument));
    return;
  }
  throw new Error("usage: rbox config [--json] | add <path> | regenerate [--yes] | repair <path>");
}
