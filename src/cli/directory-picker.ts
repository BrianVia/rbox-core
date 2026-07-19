import fs, { type Dirent, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";

const HIDDEN_SUGGESTIONS = new Set([".git", "node_modules", ".rbox"]);
export const DIRECTORY_PICKER_PAGE_SIZE = 12;

export class UnsupportedPathError extends Error {
  constructor() {
    super("~user paths aren't supported — use an absolute path");
    this.name = "UnsupportedPathError";
  }
}

/** Expand the complete leading-tilde grammar accepted by interactive path prompts. */
export function expandUserPath(raw: string, home = os.homedir()): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  if (raw.startsWith("~")) throw new UnsupportedPathError();
  return raw;
}

export interface DirectoryEntryLike {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface DirectoryReader {
  readdirSync(directory: string, options: { withFileTypes: true }): DirectoryEntryLike[];
  statSync(entry: string): Pick<Stats, "isDirectory">;
}

export interface DirectoryListing {
  children: string[];
  notice?: string;
}

const nodeDirectoryReader: DirectoryReader = {
  readdirSync: (directory, options) => fs.readdirSync(directory, options) as Dirent[],
  statSync: (entry) => fs.statSync(entry),
};

function readableError(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES") return "permission denied";
  if (code === "ENOENT") return "does not exist";
  if (code === "ENOTDIR") return "not a directory";
  return undefined;
}

/** Blocking, lifetime-scoped directory listings. Errors are memoized too. */
export class DirectoryListingCache {
  readonly #reader: DirectoryReader;
  readonly #listings = new Map<string, DirectoryListing>();

  constructor(reader: DirectoryReader = nodeDirectoryReader) {
    this.#reader = reader;
  }

  get(directory: string): DirectoryListing {
    const cached = this.#listings.get(directory);
    if (cached) return cached;

    let entries: DirectoryEntryLike[];
    try {
      entries = this.#reader.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      const reason = readableError(error);
      if (!reason) throw error;
      const listing = { children: [], notice: `can't read ${directory}: ${reason}` };
      this.#listings.set(directory, listing);
      return listing;
    }

    const children: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!HIDDEN_SUGGESTIONS.has(entry.name)) children.push(entry.name);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      try {
        if (this.#reader.statSync(path.join(directory, entry.name)).isDirectory() && !HIDDEN_SUGGESTIONS.has(entry.name)) {
          children.push(entry.name);
        }
      } catch {
        // A broken or unstatable symlink is reachable by typing, but is not suggested.
      }
    }
    const listing = { children };
    this.#listings.set(directory, listing);
    return listing;
  }
}

export type DirectoryRowKind = "use-input" | "use-current" | "child";
type MatchClass = 0 | 1 | 2;

export interface DirectoryPickerRow {
  kind: DirectoryRowKind;
  label: string;
  answer: string;
  name: string;
  matchClass: MatchClass;
  matchSpan: number;
}

interface MatchScore {
  matchClass: MatchClass;
  matchSpan: number;
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return a.length - b.length;
}

function scoreMatch(name: string, term: string): MatchScore | undefined {
  const candidate = normalized(name);
  const query = normalized(term);
  if (candidate.startsWith(query)) return { matchClass: 0, matchSpan: Array.from(query).length };

  const substringAt = candidate.indexOf(query);
  if (substringAt !== -1) return { matchClass: 1, matchSpan: Array.from(query).length };

  const candidatePoints = Array.from(candidate);
  const queryPoints = Array.from(query);
  let tightest = Number.POSITIVE_INFINITY;
  for (let start = 0; start < candidatePoints.length; start++) {
    if (candidatePoints[start] !== queryPoints[0]) continue;
    let queryAt = 1;
    let end = start;
    while (++end < candidatePoints.length && queryAt < queryPoints.length) {
      if (candidatePoints[end] === queryPoints[queryAt]) queryAt++;
    }
    if (queryAt === queryPoints.length) tightest = Math.min(tightest, end - start);
  }
  if (!Number.isFinite(tightest)) return undefined;
  return { matchClass: 2, matchSpan: tightest };
}

function syntheticPrecedence(kind: DirectoryRowKind): number {
  if (kind === "use-input") return 0;
  if (kind === "use-current") return 1;
  return 2;
}

/** The locale-independent total comparator required by design 159. */
export function compareDirectoryRows(left: DirectoryPickerRow, right: DirectoryPickerRow): number {
  const synthetic = syntheticPrecedence(left.kind) - syntheticPrecedence(right.kind);
  if (synthetic !== 0) return synthetic;
  if (left.kind !== "child" || right.kind !== "child") return compareCodePoints(left.answer, right.answer);

  if (left.matchClass !== right.matchClass) return left.matchClass - right.matchClass;
  if (left.matchSpan !== right.matchSpan) return left.matchSpan - right.matchSpan;
  const dot = Number(left.name.startsWith(".")) - Number(right.name.startsWith("."));
  if (dot !== 0) return dot;
  const folded = compareCodePoints(normalized(left.name), normalized(right.name));
  if (folded !== 0) return folded;
  return compareCodePoints(left.name, right.name);
}

export function rankDirectoryChildren(names: readonly string[], term: string, directory: string): DirectoryPickerRow[] {
  const rows: DirectoryPickerRow[] = [];
  for (const name of names) {
    const score = scoreMatch(name, term);
    if (!score) continue;
    rows.push({
      kind: "child",
      label: `${name}/`,
      answer: path.join(directory, name),
      name,
      ...score,
    });
  }
  return rows.sort(compareDirectoryRows);
}

export interface DirectoryPickerOptions {
  message: string;
  cwd: string;
  default?: string;
  home?: string;
  cache?: DirectoryListingCache;
}

export interface DirectoryProjection {
  raw: string;
  lexical: string;
  boundary: boolean;
  filterTerm: string;
  expanded?: string;
  resolved?: string;
  listDir?: string;
  defaultAnswer?: string;
  rows: DirectoryPickerRow[];
  children: DirectoryPickerRow[];
  notice?: string;
}

function submission(raw: string, cwd: string, home: string): string {
  return path.resolve(cwd, expandUserPath(raw.trim(), home));
}

function unsupportedNotice(error: UnsupportedPathError): string {
  return error.message;
}

/** Pure staged projection apart from the cache's synchronous, memoized read. */
export function projectDirectoryPicker(
  raw: string,
  opts: DirectoryPickerOptions,
  cache = opts.cache ?? new DirectoryListingCache(),
): DirectoryProjection {
  const home = opts.home ?? os.homedir();
  const lexical = raw.trim();
  const boundary = lexical === "" || lexical === "~" || lexical.endsWith("/");
  const finalSlash = lexical.lastIndexOf("/");
  const filterTerm = boundary ? "" : lexical.slice(finalSlash + 1);
  const base = { raw, lexical, boundary, filterTerm };

  let expanded: string;
  let resolved: string;
  try {
    expanded = expandUserPath(lexical, home);
    resolved = path.resolve(opts.cwd, expanded);
  } catch (error) {
    if (!(error instanceof UnsupportedPathError)) throw error;
    return { ...base, rows: [], children: [], notice: unsupportedNotice(error) };
  }

  let listDir: string;
  let defaultAnswer: string | undefined;
  if (lexical === "") {
    try {
      defaultAnswer = submission(opts.default ?? "", opts.cwd, home);
      listDir = defaultAnswer;
    } catch (error) {
      if (!(error instanceof UnsupportedPathError)) throw error;
      const rows = raw === "" ? [] : [{
        kind: "use-input" as const,
        label: `use "${resolved}"`,
        answer: resolved,
        name: resolved,
        matchClass: 0 as const,
        matchSpan: 0,
      }];
      return { ...base, expanded, resolved, rows, children: [], notice: unsupportedNotice(error) };
    }
  } else {
    listDir = boundary ? resolved : path.dirname(resolved);
  }

  const listing = cache.get(listDir);
  const children = rankDirectoryChildren(listing.children, filterTerm, listDir);
  const rows: DirectoryPickerRow[] = [];
  if (raw !== "") {
    rows.push({
      kind: "use-input",
      label: `use "${resolved}"`,
      answer: resolved,
      name: resolved,
      matchClass: 0,
      matchSpan: 0,
    });
  }
  if (filterTerm === "") {
    rows.push({
      kind: "use-current",
      label: `use this directory (${listDir})`,
      answer: listDir,
      name: listDir,
      matchClass: 0,
      matchSpan: 0,
    });
  }
  rows.push(...children);
  return { ...base, expanded, resolved, listDir, defaultAnswer, rows, children, notice: listing.notice };
}

/** Rewrite only the final lexical segment using the best-ranked child. */
export function tabRewrite(projection: DirectoryProjection, cwd: string): string | undefined {
  const child = projection.children[0];
  if (!child || !projection.listDir) return undefined;
  if (projection.lexical === "") {
    return projection.listDir === path.resolve(cwd) ? `${child.name}/` : `${child.answer}${path.sep}`;
  }
  if (projection.lexical === "~") return `~/${child.name}/`;
  const slash = projection.lexical.lastIndexOf("/");
  const prefix = slash === -1 ? "" : projection.lexical.slice(0, slash + 1);
  return `${prefix}${child.name}/`;
}

export function highlightedAnswer(
  projection: DirectoryProjection,
  highlight: number,
): string | undefined {
  if (projection.raw === "" && highlight === 0) return projection.defaultAnswer;
  return projection.rows.slice(0, DIRECTORY_PICKER_PAGE_SIZE)[highlight]?.answer;
}
