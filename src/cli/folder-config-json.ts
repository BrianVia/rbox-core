/** Closed schema-v1 projection for `rbox config --json`.
 *
 * Never: machine-triage compatibility fields, filesystem discovery, rendering, or mutation.
 */
import {
  FOLDER_IGNORE_PATHS_MAX,
  FOLDER_PATH_MAX_BYTES,
  FOLDER_TRASH_MAX_BYTES,
  FOLDER_TRASH_MAX_DAYS,
  type FolderCatalogState,
  type FolderOptions,
  type ResolvedFolderPolicy,
} from "./folder-config.js";
import type { FolderAdmission, FolderInventoryRow } from "./folder-inventory.js";
import { folderCatalogPath } from "./rbox-paths.js";
import type { JsonObject, JsonValue } from "../json.js";

export interface FolderConfigJsonFolderV1 {
  path: string;
  status: FolderAdmission["kind"];
  name?: string;
  options?: FolderOptions;
  effectiveOptions?: ResolvedFolderPolicy;
  reason?: string;
  binding?: { workspaceId: string; deviceId: string } | { unreadable: string };
  overlap?: { kind: "ancestor" | "descendant" | "alias"; of: string };
}

export interface FolderConfigJsonV1 {
  schemaVersion: 1;
  catalogPath: string;
  globalOptions: FolderOptions;
  folders: FolderConfigJsonFolderV1[];
}

/** One field read out of a parsed JSON object: a JSON value, or absent. */
type JsonField = JsonValue | undefined;

function record(value: JsonField, at: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${at} must be an object`);
  return value;
}

function closed(value: JsonObject, keys: readonly string[], at: string): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) throw new Error(`${at}.${unknown} is not supported`);
}

function string(value: JsonField, at: string): string {
  if (typeof value !== "string") throw new Error(`${at} must be a string`);
  return value;
}

function boundedInteger(value: JsonField, max: number, at: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${at} must be an integer from 0 through ${max}`);
  }
  return value;
}

function options(value: JsonField, at: string, resolved: boolean): FolderOptions | ResolvedFolderPolicy {
  const raw = record(value, at);
  closed(raw, ["syncGit", "git", "respectGitignore", "ignorePaths", "noDrift", "trash"], at);
  for (const key of ["syncGit", "respectGitignore", "noDrift"] as const) {
    if ((resolved || Object.hasOwn(raw, key)) && typeof raw[key] !== "boolean") throw new Error(`${at}.${key} must be boolean`);
  }
  if (resolved || Object.hasOwn(raw, "ignorePaths")) {
    if (!Array.isArray(raw.ignorePaths)) throw new Error(`${at}.ignorePaths must be an array`);
    if (raw.ignorePaths.length > FOLDER_IGNORE_PATHS_MAX) throw new Error(`${at}.ignorePaths exceeds ${FOLDER_IGNORE_PATHS_MAX} entries`);
    for (const [index, entry] of raw.ignorePaths.entries()) {
      if (typeof entry !== "string") throw new Error(`${at}.ignorePaths[${index}] must be a string`);
      if (Buffer.byteLength(entry, "utf8") > FOLDER_PATH_MAX_BYTES) throw new Error(`${at}.ignorePaths[${index}] is too long`);
    }
  }
  for (const [key, child] of [["git", "incremental"], ["trash", "days"], ["trash", "maxBytes"]] as const) {
    if (!Object.hasOwn(raw, key)) {
      if (resolved) throw new Error(`${at}.${key} is required`);
      continue;
    }
    const nested = record(raw[key], `${at}.${key}`);
    closed(nested, key === "git" ? ["incremental"] : ["days", "maxBytes"], `${at}.${key}`);
    if (resolved || Object.hasOwn(nested, child)) {
      if (key === "git") {
        if (typeof nested[child] !== "boolean") throw new Error(`${at}.${key}.${child} must be boolean`);
      } else {
        boundedInteger(
          nested[child],
          child === "days" ? FOLDER_TRASH_MAX_DAYS : FOLDER_TRASH_MAX_BYTES,
          `${at}.${key}.${child}`,
        );
      }
    }
  }
  return raw as FolderOptions | ResolvedFolderPolicy;
}

/** Runtime decoder keeps this machine surface closed across future refactors. */
export function parseFolderConfigJson(bytes: string): FolderConfigJsonV1 {
  const top = record(JSON.parse(bytes) as JsonValue, "$");
  closed(top, ["schemaVersion", "catalogPath", "globalOptions", "folders"], "$");
  if (top.schemaVersion !== 1) throw new Error("$.schemaVersion must be 1");
  const catalogPath = string(top.catalogPath, "$.catalogPath");
  const globalOptions = options(top.globalOptions, "$.globalOptions", false) as FolderOptions;
  if (!Array.isArray(top.folders)) throw new Error("$.folders must be an array");
  const statuses = new Set<FolderAdmission["kind"]>(["admitted", "unbound", "missing", "detached", "damaged", "ambiguous"]);
  const folders = top.folders.map((value, index): FolderConfigJsonFolderV1 => {
    const at = `$.folders[${index}]`;
    const raw = record(value, at);
    closed(raw, ["path", "status", "name", "options", "effectiveOptions", "reason", "binding", "overlap"], at);
    const status = string(raw.status, `${at}.status`) as FolderAdmission["kind"];
    if (!statuses.has(status)) throw new Error(`${at}.status is not supported`);
    const row: FolderConfigJsonFolderV1 = { path: string(raw.path, `${at}.path`), status };
    if (Object.hasOwn(raw, "name")) row.name = string(raw.name, `${at}.name`);
    if (Object.hasOwn(raw, "options")) row.options = options(raw.options, `${at}.options`, false) as FolderOptions;
    if (Object.hasOwn(raw, "effectiveOptions")) row.effectiveOptions = options(raw.effectiveOptions, `${at}.effectiveOptions`, true) as ResolvedFolderPolicy;
    if (Object.hasOwn(raw, "reason")) row.reason = string(raw.reason, `${at}.reason`);
    if (Object.hasOwn(raw, "binding")) {
      const binding = record(raw.binding, `${at}.binding`);
      if (Object.hasOwn(binding, "unreadable")) {
        closed(binding, ["unreadable"], `${at}.binding`);
        row.binding = { unreadable: string(binding.unreadable, `${at}.binding.unreadable`) };
      } else {
        closed(binding, ["workspaceId", "deviceId"], `${at}.binding`);
        row.binding = {
          workspaceId: string(binding.workspaceId, `${at}.binding.workspaceId`),
          deviceId: string(binding.deviceId, `${at}.binding.deviceId`),
        };
      }
    }
    if (Object.hasOwn(raw, "overlap")) {
      const overlap = record(raw.overlap, `${at}.overlap`);
      closed(overlap, ["kind", "of"], `${at}.overlap`);
      const kind = string(overlap.kind, `${at}.overlap.kind`);
      if (kind !== "ancestor" && kind !== "descendant" && kind !== "alias") throw new Error(`${at}.overlap.kind is not supported`);
      row.overlap = { kind, of: string(overlap.of, `${at}.overlap.of`) };
    }
    return row;
  });
  return { schemaVersion: 1, catalogPath, globalOptions, folders };
}

export function projectFolderConfigJson(
  state: Extract<FolderCatalogState, { kind: "authoritative" }>,
  rows: readonly FolderInventoryRow[],
): FolderConfigJsonV1 {
  const value: FolderConfigJsonV1 = {
    schemaVersion: 1,
    catalogPath: folderCatalogPath(),
    globalOptions: structuredClone(state.snapshot.catalog.globalOptions),
    folders: rows.map((row) => ({
      path: row.root,
      status: row.admission.kind,
      ...(row.catalog === undefined ? {} : {
        name: row.catalog.name,
        ...(row.catalog.options === undefined ? {} : { options: structuredClone(row.catalog.options) }),
        effectiveOptions: structuredClone(row.catalog.policy),
      }),
      ...(row.admission.kind === "admitted" ? {} : { reason: row.admission.reason }),
      ...(row.binding === undefined ? {} : { binding: structuredClone(row.binding) }),
      ...(row.overlap === undefined ? {} : { overlap: { ...row.overlap } }),
    })),
  };
  return parseFolderConfigJson(JSON.stringify(value));
}
