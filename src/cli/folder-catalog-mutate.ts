/** Explicit, compare-before-publish mutations of authoritative folder intent. */
import path from "node:path";
import {
  collapseFolderPath,
  expandFolderPath,
  resolveFolderPolicy,
  serializeFolderCatalog,
  type FolderCatalog,
  type FolderCatalogSnapshot,
  type FolderOptions,
  type ResolvedFolderPolicy,
} from "./folder-config-codec.js";
import { deriveFolderLabel } from "./folder-catalog-generate.js";
import publishInternals, { type FolderCatalogPublicationOptions } from "./folder-catalog-publish.js";

export interface FolderSeed {
  options?: FolderOptions;
}

export interface FolderOptionsPatch {
  syncGit?: boolean | undefined;
  git?: { incremental?: boolean | undefined } | undefined;
  respectGitignore?: boolean | undefined;
  noDrift?: boolean | undefined;
  trash?: { days?: number | undefined; maxBytes?: number | undefined } | undefined;
}

type MutateOptions = { publication?: FolderCatalogPublicationOptions };

function cloneCatalog(catalog: FolderCatalog): FolderCatalog {
  return {
    schemaVersion: 1,
    globalOptions: structuredClone(catalog.globalOptions),
    folders: catalog.folders.map((folder) => structuredClone(folder)),
  };
}

function hasFields(options: FolderOptions): boolean {
  return options.syncGit !== undefined
    || options.respectGitignore !== undefined
    || options.noDrift !== undefined
    || options.git?.incremental !== undefined
    || options.trash?.days !== undefined
    || options.trash?.maxBytes !== undefined;
}

function assertKeys(value: object, allowed: readonly string[], at: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${at}.${unknown} is not supported`);
}

function applyPatch(current: FolderOptions, patch: FolderOptionsPatch): FolderOptions {
  assertKeys(patch, ["syncGit", "git", "respectGitignore", "noDrift", "trash"], "folder options patch");
  const next = structuredClone(current);
  for (const key of ["syncGit", "respectGitignore", "noDrift"] as const) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  if (Object.hasOwn(patch, "git")) {
    if (patch.git === undefined) delete next.git;
    else {
      assertKeys(patch.git, ["incremental"], "folder options patch.git");
      const git = { ...next.git };
      if (Object.hasOwn(patch.git, "incremental")) {
        if (patch.git.incremental === undefined) delete git.incremental;
        else git.incremental = patch.git.incremental;
      }
      if (git.incremental === undefined) delete next.git;
      else next.git = git;
    }
  }
  if (Object.hasOwn(patch, "trash")) {
    if (patch.trash === undefined) delete next.trash;
    else {
      assertKeys(patch.trash, ["days", "maxBytes"], "folder options patch.trash");
      const trash = { ...next.trash };
      for (const key of ["days", "maxBytes"] as const) {
        if (!Object.hasOwn(patch.trash, key)) continue;
        const value = patch.trash[key];
        if (value === undefined) delete trash[key];
        else trash[key] = value;
      }
      if (trash.days === undefined && trash.maxBytes === undefined) delete next.trash;
      else next.trash = trash;
    }
  }
  return next;
}

export async function recordFolder(
  root: string,
  seed: FolderSeed = {},
  options: MutateOptions = {},
): Promise<FolderCatalogSnapshot> {
  return publishInternals.lockedMutation((state) => {
    if (state.kind !== "authoritative") throw publishInternals.authorityError(state);
    const normalized = expandFolderPath(path.resolve(root));
    if (state.snapshot.folders.some((folder) => folder.normalizedPath === normalized)) {
      return { kind: "unchanged", value: state.snapshot };
    }
    const catalog = cloneCatalog(state.snapshot.catalog);
    catalog.folders.push({
      name: deriveFolderLabel(normalized, new Set(catalog.folders.map((folder) => folder.name))),
      path: collapseFolderPath(normalized),
      ...(seed.options === undefined ? {} : { options: seed.options }),
    });
    return { kind: "replace", bytes: serializeFolderCatalog(catalog), value: (snapshot) => snapshot };
  }, options.publication);
}

export async function forgetFolder(
  root: string,
  options: MutateOptions = {},
): Promise<FolderCatalogSnapshot> {
  return publishInternals.lockedMutation((state) => {
    if (state.kind !== "authoritative") throw publishInternals.authorityError(state);
    const normalized = expandFolderPath(path.resolve(root));
    const kept = state.snapshot.folders.filter((folder) => folder.normalizedPath !== normalized);
    if (kept.length === state.snapshot.folders.length) {
      return { kind: "unchanged", value: state.snapshot };
    }
    const catalog = cloneCatalog(state.snapshot.catalog);
    catalog.folders = catalog.folders.filter((folder) => expandFolderPath(folder.path) !== normalized);
    return { kind: "replace", bytes: serializeFolderCatalog(catalog), value: (snapshot) => snapshot };
  }, options.publication);
}

export async function setFolderOptions(
  root: string,
  patch: FolderOptionsPatch,
  options: MutateOptions = {},
): Promise<ResolvedFolderPolicy> {
  return publishInternals.lockedMutation((state) => {
    if (state.kind !== "authoritative") throw publishInternals.authorityError(state);
    const normalized = expandFolderPath(path.resolve(root));
    const index = state.snapshot.folders.findIndex((folder) => folder.normalizedPath === normalized);
    if (index < 0) throw new Error(`folder is not listed in rbox configuration: ${normalized}`);
    const catalog = cloneCatalog(state.snapshot.catalog);
    const entry = catalog.folders[index]!;
    const next = applyPatch(entry.options ?? {}, patch);
    if (hasFields(next)) entry.options = next;
    else delete entry.options;
    const policy = resolveFolderPolicy(catalog.globalOptions, next);
    return { kind: "replace", bytes: serializeFolderCatalog(catalog), value: () => policy };
  }, options.publication);
}
