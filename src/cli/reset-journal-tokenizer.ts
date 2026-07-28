export type ResetJournalTokenErrorCode =
  | "JSON_SYNTAX" | "DEPTH_LIMIT" | "TOKEN_LIMIT" | "MEMBER_LIMIT"
  | "MEMBER_NAME_LIMIT" | "STRING_LIMIT" | "DUPLICATE_MEMBER"
  | "NUMBER_NONCANONICAL" | "NUMBER_RANGE" | "UNKNOWN_MEMBER";

export class ResetJournalTokenError extends Error {
  constructor(
    readonly code: ResetJournalTokenErrorCode,
    readonly charOffset: number,
    readonly jsonPath: string,
    readonly limit: number | null = null,
  ) {
    super(code);
  }
}

const MAX_DEPTH = 6;
const MAX_TOKENS = 8_192;
const MAX_MEMBERS = 4_096;
const MAX_MEMBER_BYTES = 32;
const MAX_VALUE_STRING_BYTES = 524_288;
const encoder = new TextEncoder();
const keys = (...values: string[]): ReadonlySet<string> => new Set(values);
const ALLOWED_KEYS: ReadonlyArray<[RegExp, ReadonlySet<string>]> = [
  [/^\$$/, keys("v", "stateFormat", "id", "phase", "createdAt", "authorization", "authorityId", "sqliteApplicationId", "sqliteUserVersion", "storeSchemaVersion", "old", "next")],
  [/^\$\.authorization$/, keys("version", "authorizedNextStream", "consentKind", "mintedAtRevision")],
  [/^\$\.old$/, keys("stream", "stateNonce", "stateRevision", "stateSha256", "archiveBaseline", "z")],
  [/^\$\.old\.z\[\d+\]$/, keys("lineageHash", "repositoryIdentityHash", "repositoryIdentity", "activeRef", "targetOid", "recoveryRef")],
  [/^\$\.old\.z\[\d+\]\.repositoryIdentity$/, keys("relPath", "kind", "worktreeId", "gitDirReal", "commonDirReal", "dev", "ino", "birthtime")],
  [/^\$\.next$/, keys("stream", "stateNonce", "stateRevision", "stateSha256", "state", "dbBytesB64")],
  [/^\$\.next\.state$/, keys("stream", "stateNonce", "stateRevision", "lastSyncedSequence", "lastSyncedManifest", "repoRecords", "telemetryBindingId")],
  [/^\$\.next\.state\.lastSyncedManifest$/, keys("generatedAt", "files")],
  [/^\$\.next\.state\.repoRecords$/, keys()],
];

function memberAllowed(parentPath: string, member: string): boolean {
  const rule = ALLOWED_KEYS.find(([pattern]) => pattern.test(parentPath));
  return rule === undefined || rule[1].has(member);
}

const childPath = (base: string, key: string | number): string =>
  typeof key === "number" ? `${base}[${key}]` : `${base}.${key}`;

/**
 * A duplicate-safe strict JSON machine. It deliberately produces null-
 * prototype records, so hostile member names never interact with prototypes.
 */
export function tokenizeResetJournalJson(text: string): unknown {
  let at = 0;
  let tokens = 0;
  let members = 0;
  let valueStringBytes = 0;

  const fail = (code: ResetJournalTokenErrorCode, path: string, limit: number | null = null, offset = at): never => {
    throw new ResetJournalTokenError(code, offset, path, limit);
  };
  const charge = (path: string): void => {
    tokens++;
    if (tokens > MAX_TOKENS) fail("TOKEN_LIMIT", path, MAX_TOKENS);
  };
  const whitespace = (): void => {
    while (at < text.length && (text[at] === " " || text[at] === "\n" || text[at] === "\r" || text[at] === "\t")) at++;
  };
  const string = (path: string, memberName: boolean, excludedValue = false): string => {
    if (text[at] !== "\"") fail("JSON_SYNTAX", path);
    at++;
    let result = "";
    while (at < text.length) {
      const ch = text.charCodeAt(at++);
      if (ch === 0x22) {
        const bytes = encoder.encode(result).byteLength;
        if (memberName && bytes > MAX_MEMBER_BYTES) fail("MEMBER_NAME_LIMIT", path, MAX_MEMBER_BYTES);
        if (!memberName && !excludedValue) {
          valueStringBytes += bytes;
          if (valueStringBytes > MAX_VALUE_STRING_BYTES) fail("STRING_LIMIT", path, MAX_VALUE_STRING_BYTES);
        }
        return result;
      }
      if (ch < 0x20) fail("JSON_SYNTAX", path, null, at - 1);
      if (ch !== 0x5c) {
        result += String.fromCharCode(ch);
        continue;
      }
      if (at >= text.length) fail("JSON_SYNTAX", path);
      const escaped = text[at++]!;
      const simple: Record<string, string> = {
        "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
      };
      if (simple[escaped] !== undefined) {
        result += simple[escaped];
      } else if (escaped === "u") {
        const hex = text.slice(at, at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("JSON_SYNTAX", path);
        result += String.fromCharCode(Number.parseInt(hex, 16));
        at += 4;
      } else {
        fail("JSON_SYNTAX", path, null, at - 1);
      }
    }
    return fail("JSON_SYNTAX", path);
  };
  const value = (path: string, depth: number, dbBytesValue = false): unknown => {
    whitespace();
    if (at >= text.length) fail("JSON_SYNTAX", path);
    const ch = text[at];
    if (ch === "{") {
      if (depth > MAX_DEPTH) fail("DEPTH_LIMIT", path, MAX_DEPTH);
      charge(path);
      at++;
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const seen = new Set<string>();
      whitespace();
      if (text[at] === "}") {
        at++;
        charge(path);
        return result;
      }
      while (true) {
        whitespace();
        const keyOffset = at;
        const key = string(path, true);
        charge(childPath(path, key));
        members++;
        if (members > MAX_MEMBERS) fail("MEMBER_LIMIT", childPath(path, key), MAX_MEMBERS, keyOffset);
        if (seen.has(key)) fail("DUPLICATE_MEMBER", childPath(path, key), null, keyOffset);
        seen.add(key);
        if (!memberAllowed(path, key)) fail("UNKNOWN_MEMBER", childPath(path, key), null, keyOffset);
        whitespace();
        if (text[at++] !== ":") fail("JSON_SYNTAX", childPath(path, key));
        result[key] = value(childPath(path, key), depth + 1, key === "dbBytesB64");
        whitespace();
        if (text[at] === "}") {
          at++;
          charge(path);
          return result;
        }
        if (text[at++] !== ",") fail("JSON_SYNTAX", path);
      }
    }
    if (ch === "[") {
      if (depth > MAX_DEPTH) fail("DEPTH_LIMIT", path, MAX_DEPTH);
      charge(path);
      at++;
      const result: unknown[] = [];
      whitespace();
      if (text[at] === "]") {
        at++;
        charge(path);
        return result;
      }
      while (true) {
        result.push(value(childPath(path, result.length), depth + 1));
        whitespace();
        if (text[at] === "]") {
          at++;
          charge(path);
          return result;
        }
        if (text[at++] !== ",") fail("JSON_SYNTAX", path);
      }
    }
    if (ch === "\"") {
      charge(path);
      return string(path, false, dbBytesValue);
    }
    for (const [literal, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(literal, at)) {
        at += literal.length;
        charge(path);
        return result;
      }
    }
    const start = at;
    if (ch !== "-" && (ch === undefined || ch < "0" || ch > "9")) fail("JSON_SYNTAX", path, null, start);
    if (ch === "-") at++;
    while (at < text.length && /[0-9.eE+-]/.test(text[at]!)) at++;
    const lexeme = text.slice(start, at);
    if (!/^(?:0|[1-9][0-9]{0,15})$/.test(lexeme)) fail("NUMBER_NONCANONICAL", path, null, start);
    const number = Number(lexeme);
    if (!Number.isSafeInteger(number) || number < 0) fail("NUMBER_RANGE", path, Number.MAX_SAFE_INTEGER, start);
    charge(path);
    return number;
  };

  whitespace();
  const result = value("$", 1);
  whitespace();
  if (at !== text.length) fail("JSON_SYNTAX", "$");
  return result;
}

export function resetJournalByteOffset(text: string, charOffset: number): number {
  return encoder.encode(text.slice(0, charOffset)).byteLength;
}
