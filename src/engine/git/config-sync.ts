import type { GitSection } from "../types.js";

/** Pure grammar, projection, and canonical-wire helpers for design 93 git config sync.
 * Keep this module node-free: manifest validation is also bundled into the Worker. */

export type GitConfig = Record<string, string[]>;

export const MAX_GIT_CONFIG_KEYS = 512;
export const MAX_GIT_CONFIG_KEY_BYTES = 200;
export const MAX_GIT_CONFIG_NAME_BYTES = 120;
export const MAX_GIT_CONFIG_VALUE_BYTES = 1024;
export const MAX_GIT_CONFIG_SERIALIZED_BYTES = 64 * 1024;
export const MAX_GIT_CONFIG_FILE_BYTES = 1024 * 1024;

/** The single allowlist used by capture projection and wire validation. */
export const GIT_CONFIG_ALLOWLIST = {
  remote: ["url", "fetch"],
  branch: ["remote", "merge", "rebase"],
} as const;

export type GitConfigKey =
  | { section: "remote"; name: string; variable: (typeof GIT_CONFIG_ALLOWLIST.remote)[number] }
  | { section: "branch"; name: string; variable: (typeof GIT_CONFIG_ALLOWLIST.branch)[number] };

export type GitConfigValidation = { ok: true; config: GitConfig } | { ok: false; reason: string };

export interface RejectedGitConfigValue {
  key: string;
  value: string;
  reason: string;
  credential: boolean;
}

export type GitConfigBound = "key-count" | "key-bytes" | "name-bytes" | "value-bytes" | "serialized-bytes";

export type GitConfigCanonicalization =
  | { ok: true; config: GitConfig; rejected: RejectedGitConfigValue[] }
  | { ok: false; overBounds: false; reason: string; rejected: RejectedGitConfigValue[] }
  | {
      ok: false;
      overBounds: true;
      bound: GitConfigBound;
      reason: string;
      rejected: RejectedGitConfigValue[];
    };

const utf8 = new TextEncoder();
const CONTROL_OR_DEL = /[\u0000-\u001f\u007f]/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const byteLength = (value: string): number => utf8.encode(value).length;

/** Compare strings by their UTF-8 bytes (the wire ordering rule), not UTF-16 units. */
export function compareConfigKeysBytewise(a: string, b: string): number {
  const aa = utf8.encode(a);
  const bb = utf8.encode(b);
  const common = Math.min(aa.length, bb.length);
  for (let i = 0; i < common; i++) {
    if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
  }
  return aa.length - bb.length;
}

/** One component of a refs/heads refname, following git-check-ref-format core rules. */
export function refComponentOk(component: string): boolean {
  if (component.length === 0 || component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock")) return false;
  if (component.includes("..") || component.includes("@{")) return false;
  // Slash is excluded here because callers validate one component at a time.
  return !/[\u0000-\u0020\u007f~^:?*\[\\/]/.test(component);
}

export function refNameOk(name: string): boolean {
  if (name.length === 0) return false;
  return name.split("/").every(refComponentOk);
}

export function remoteNameOk(name: string): boolean {
  return byteLength(name) <= MAX_GIT_CONFIG_NAME_BYTES && REMOTE_NAME.test(name);
}

export function branchNameOk(name: string): boolean {
  return byteLength(name) <= MAX_GIT_CONFIG_NAME_BYTES && refNameOk(name);
}

/** Parse an allowlisted key without applying the wire byte bounds. */
function parseUnboundedGitConfigKey(key: string): GitConfigKey | undefined {
  if (CONTROL_OR_DEL.test(key)) return undefined;
  for (const variable of GIT_CONFIG_ALLOWLIST.remote) {
    const prefix = "remote.";
    const suffix = `.${variable}`;
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      const name = key.slice(prefix.length, -suffix.length);
      if (REMOTE_NAME.test(name)) return { section: "remote", name, variable };
    }
  }
  for (const variable of GIT_CONFIG_ALLOWLIST.branch) {
    const prefix = "branch.";
    const suffix = `.${variable}`;
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      const name = key.slice(prefix.length, -suffix.length);
      if (refNameOk(name)) return { section: "branch", name, variable };
    }
  }
  return undefined;
}

/** Parse an exact allowlisted key. Literal section/variable names are canonical lowercase. */
export function parseGitConfigKey(key: string): GitConfigKey | undefined {
  const parsed = parseUnboundedGitConfigKey(key);
  if (!parsed || byteLength(key) > MAX_GIT_CONFIG_KEY_BYTES || byteLength(parsed.name) > MAX_GIT_CONFIG_NAME_BYTES) return undefined;
  return parsed;
}

function parsedUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Used by capture to distinguish the required loud credential skip from other bad values. */
export function hasHttpUserinfo(value: string): boolean {
  const url = parsedUrl(value);
  return !!url && (url.protocol === "http:" || url.protocol === "https:") && (url.username !== "" || url.password !== "");
}

export function remoteUrlOk(value: string): boolean {
  if (value.length === 0 || CONTROL_OR_DEL.test(value) || value.includes("::")) return false;
  const url = parsedUrl(value);
  if (value.startsWith("https://") && url?.protocol === "https:") return url.hostname !== "" && url.username === "" && url.password === "";
  if (value.startsWith("ssh://") && url?.protocol === "ssh:") return url.hostname !== "" && url.password === "";
  if (value.includes("://")) return false;
  if (/^(?:https?|ssh|git|file):/i.test(value)) return false;
  // SCP-form SSH: [user@]host:path. Colons in the path are allowed; an empty path is not.
  return /^(?:[^\s\/@:]+@)?[^\s\/@:]+:[^\s:][^\s]*$/.test(value);
}

export function remoteFetchOk(value: string, remoteName: string): boolean {
  const body = value.startsWith("+") ? value.slice(1) : value;
  const split = body.indexOf(":");
  if (split < 0 || body.indexOf(":", split + 1) >= 0) return false;
  const sourcePrefix = "refs/heads/";
  const destinationPrefix = `refs/remotes/${remoteName}/`;
  const source = body.slice(0, split);
  const destination = body.slice(split + 1);
  if (!source.startsWith(sourcePrefix) || !destination.startsWith(destinationPrefix)) return false;
  const sourceComponent = source.slice(sourcePrefix.length);
  const destinationComponent = destination.slice(destinationPrefix.length);
  const sourceOk = sourceComponent === "*" || refComponentOk(sourceComponent);
  const destinationOk = destinationComponent === "*" || refComponentOk(destinationComponent);
  return sourceOk && destinationOk && (sourceComponent === "*") === (destinationComponent === "*");
}

export function branchMergeOk(value: string): boolean {
  const prefix = "refs/heads/";
  return value.startsWith(prefix) && refNameOk(value.slice(prefix.length));
}

export function branchRebaseOk(value: string): boolean {
  return value === "true" || value === "false" || value === "merges" || value === "interactive";
}

/** Validate one value where validation does not require seeing sibling keys. */
export function gitConfigValueOk(key: GitConfigKey, value: string): boolean {
  if (CONTROL_OR_DEL.test(value) || byteLength(value) > MAX_GIT_CONFIG_VALUE_BYTES) return false;
  if (key.section === "remote") {
    return key.variable === "url" ? remoteUrlOk(value) : remoteFetchOk(value, key.name);
  }
  if (key.variable === "merge") return branchMergeOk(value);
  if (key.variable === "rebase") return branchRebaseOk(value);
  return remoteNameOk(value); // branch.<name>.remote; sibling existence is checked below.
}

function remoteNames(config: Readonly<Record<string, readonly string[]>>): Set<string> {
  const names = new Set<string>();
  for (const key of Object.keys(config)) {
    const parsed = parseGitConfigKey(key);
    if (parsed?.section === "remote") names.add(parsed.name);
  }
  return names;
}

function serializedSize(config: Readonly<Record<string, readonly string[]>>): number {
  return byteLength(JSON.stringify(config));
}

/** Validate that untrusted wire data is both grammatical and already canonical. */
export function validateCanonicalGitConfig(input: unknown): GitConfigValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "config is not an object" };
  const config = input as Record<string, unknown>;
  const keys = Object.keys(config);
  if (keys.length > MAX_GIT_CONFIG_KEYS) return { ok: false, reason: `config exceeds ${MAX_GIT_CONFIG_KEYS} keys` };
  const sorted = [...keys].sort(compareConfigKeysBytewise);
  if (keys.some((key, i) => key !== sorted[i])) return { ok: false, reason: "config keys are not bytewise sorted" };

  const parsedByKey = new Map<string, GitConfigKey>();
  for (const key of keys) {
    const parsed = parseGitConfigKey(key);
    if (!parsed) return { ok: false, reason: `config key is not allowlisted: ${key}` };
    parsedByKey.set(key, parsed);
    const values = config[key];
    if (!Array.isArray(values) || values.length === 0) return { ok: false, reason: `config values are empty or malformed: ${key}` };
    const seen = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string" || !gitConfigValueOk(parsed, value)) return { ok: false, reason: `invalid config value: ${key}` };
      if (seen.has(value)) return { ok: false, reason: `duplicate config value: ${key}` };
      seen.add(value);
    }
  }

  const knownRemotes = remoteNames(config as Record<string, string[]>);
  for (const key of keys) {
    const parsed = parsedByKey.get(key)!;
    if (parsed.section === "branch" && parsed.variable === "remote") {
      for (const value of config[key] as string[]) {
        if (!knownRemotes.has(value)) return { ok: false, reason: `branch remote is not in this config: ${value}` };
      }
    }
  }
  if (serializedSize(config as Record<string, string[]>) > MAX_GIT_CONFIG_SERIALIZED_BYTES) {
    return { ok: false, reason: `config exceeds ${MAX_GIT_CONFIG_SERIALIZED_BYTES} serialized bytes` };
  }
  return { ok: true, config: config as GitConfig };
}

/**
 * The single persistence sanitizer for Git PENDING/BASE sections. Config is an
 * additive lane: an invalid value (or any config on a scoped section) is treated
 * as absent without mutating the caller's wire/checkpoint object. All other
 * section bytes remain exact.
 */
export function sanitizeGitSectionForPersistence(section: GitSection): GitSection {
  if (section.config === undefined) return section;
  const validation = validateCanonicalGitConfig(section.config);
  if (validation.ok && section.refScope === "all") return section;
  const sanitized = { ...section };
  delete sanitized.config;
  return sanitized;
}

/**
 * Project raw `git config --get-regexp -z` entries into canonical wire form.
 * Unknown keys and bad values are skipped; duplicates are removed first-seen-first,
 * preserving Git's value order. A bounds failure omits the whole projection.
 */
export function canonicalizeGitConfig(entries: Iterable<readonly [string, string]>): GitConfigCanonicalization {
  const collected = new Map<string, string[]>();
  const collectedValues = new Map<string, Set<string>>();
  const rejected: RejectedGitConfigValue[] = [];
  const overBounds = (bound: GitConfigBound, reason: string): GitConfigCanonicalization => ({
    ok: false,
    overBounds: true,
    bound,
    reason,
    rejected,
  });
  for (const [key, value] of entries) {
    const parsed = parseUnboundedGitConfigKey(key);
    if (!parsed) continue;
    if (byteLength(key) > MAX_GIT_CONFIG_KEY_BYTES) {
      return overBounds("key-bytes", `config key exceeds ${MAX_GIT_CONFIG_KEY_BYTES} bytes: ${key}`);
    }
    if (byteLength(parsed.name) > MAX_GIT_CONFIG_NAME_BYTES) {
      return overBounds("name-bytes", `config name exceeds ${MAX_GIT_CONFIG_NAME_BYTES} bytes: ${parsed.name}`);
    }
    if (byteLength(value) > MAX_GIT_CONFIG_VALUE_BYTES) {
      return overBounds("value-bytes", `config value exceeds ${MAX_GIT_CONFIG_VALUE_BYTES} bytes: ${key}`);
    }
    if (!gitConfigValueOk(parsed, value)) {
      rejected.push({ key, value, reason: "invalid value grammar", credential: parsed.section === "remote" && parsed.variable === "url" && hasHttpUserinfo(value) });
      continue;
    }
    const values = collected.get(key) ?? [];
    const seen = collectedValues.get(key) ?? new Set<string>();
    if (!seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
    collected.set(key, values);
    collectedValues.set(key, seen);
  }

  // A branch remote is meaningful only when that remote is defined by another key
  // in the same projected section. Remove dangling values before final canonicalization.
  const prelim = Object.fromEntries([...collected.entries()]);
  const knownRemotes = remoteNames(prelim);
  for (const [key, values] of collected) {
    const parsed = parseGitConfigKey(key)!;
    if (parsed.section !== "branch" || parsed.variable !== "remote") continue;
    const kept = values.filter((value) => {
      if (knownRemotes.has(value)) return true;
      rejected.push({ key, value, reason: "remote is not in this config", credential: false });
      return false;
    });
    if (kept.length === 0) collected.delete(key);
    else collected.set(key, kept);
  }

  const config = Object.fromEntries([...collected.entries()].sort(([a], [b]) => compareConfigKeysBytewise(a, b)));
  if (Object.keys(config).length > MAX_GIT_CONFIG_KEYS) {
    return overBounds("key-count", `config exceeds ${MAX_GIT_CONFIG_KEYS} keys`);
  }
  if (serializedSize(config) > MAX_GIT_CONFIG_SERIALIZED_BYTES) {
    return overBounds("serialized-bytes", `config exceeds ${MAX_GIT_CONFIG_SERIALIZED_BYTES} serialized bytes`);
  }
  const validation = validateCanonicalGitConfig(config);
  // The projection above removes all non-bound grammar failures. Keep the
  // validator as a final invariant check without turning one into a partial ok.
  if (!validation.ok) return { ok: false, overBounds: false, reason: validation.reason, rejected };
  return { ok: true, config: validation.config, rejected };
}
