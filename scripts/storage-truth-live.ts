/**
 * Live, read-only adapter for the design-142 storage-truth runner.
 *
 * D1 and R2 are reached through Cloudflare's direct REST APIs. Authoritative roots
 * cross the deployed Worker's platform-secret gate, which is the audited read-only
 * path.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "wrangler";
import { planFor } from "../apps/api/src/plans.js";
import { parseRefset, refsetByteLength } from "../src/engine/refset.js";
import { WorkspaceInspectionFailure } from "./storage-truth.js";
import type {
  CatalogRow,
  EntitlementRow,
  FleetReachabilityRow,
  InventoryEntry,
  ObservedObject,
  Page,
  RootEntry,
  RootsPage,
  SnapshotTriple,
  StorageTruthSource,
  WorkspaceKey,
} from "./storage-truth.js";

const SHA_RE = /^[0-9a-f]{64}$/;
const ROOT_CURSOR_VERSION = 1;
const MAX_D1_PAGE = 2_000;
const MAX_R2_PAGE = 1_000;
const MAX_PACK_PAGE = 50; // each immutable pack has up to 2,048 members
const MAX_SIDECAR_REFS = 250_000;
const FLEET_SNAPSHOT_RETRIES = 3;
export const ESTABLISHMENT_TIMEOUT_MS = 20_000;
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

interface D1Result<T> { results?: T[] }
interface D1Bound {
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
}
interface D1Prepared { bind(...values: unknown[]): D1Bound }
export interface ReadOnlyD1 { prepare(sql: string): D1Prepared }

export interface ReadOnlyR2Object {
  key: string;
  size: number;
  uploaded: Date | string;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface ReadOnlyR2ListObject { key: string; size: number; uploaded: Date | string }
export interface ReadOnlyR2 {
  get(key: string): Promise<ReadOnlyR2Object | null>;
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<{
    objects: ReadOnlyR2ListObject[];
    truncated: boolean;
    cursor?: string;
  }>;
}

export type StorageTruthConnectionComponent = "config" | "d1-rest" | "r2-rest" | "roots-inspect";

export class StorageTruthConnectionError extends Error {
  constructor(
    readonly component: StorageTruthConnectionComponent,
    readonly environment: string,
    readonly requiredEnvironment: string[],
    readonly reason: string,
    readonly timeoutMs?: number,
  ) {
    const timeout = timeoutMs === undefined ? "" : ` within ${timeoutMs}ms`;
    super(`${component} did not connect${timeout} for ${environment}: ${reason}; requires ${requiredEnvironment.join(", ") || "no environment variables"}`);
    this.name = "StorageTruthConnectionError";
  }
}

export interface StorageTruthResourceConfig {
  environment: "dev" | "production";
  databaseId: string;
  bucketName: string;
  bucketJurisdiction?: string;
}

interface CloudflareRestOptions {
  accountId: string;
  apiToken: string;
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
  jurisdiction?: string;
}

interface D1ApiMeta {
  rows_written?: number;
  changes?: number;
  changed_db?: boolean;
}

interface D1ApiQueryResult<T> {
  success?: boolean;
  results?: T[];
  meta?: D1ApiMeta;
}

function apiErrorReason(raw: unknown, fallback: string): string {
  if (!raw || typeof raw !== "object") return fallback;
  const errors = (raw as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return fallback;
  const messages = errors.flatMap((error) => {
    if (typeof error === "string") return [error];
    if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
      return [(error as { message: string }).message];
    }
    return [];
  });
  return messages.length > 0 ? messages.join(":") : fallback;
}

async function jsonResponse(response: Response, label: string): Promise<unknown> {
  let raw: unknown;
  try { raw = await response.json(); } catch { raw = null; }
  if (!response.ok) throw new Error(apiErrorReason(raw, `${label} status ${response.status}`));
  return raw;
}

/** Reject anything except one lexical SELECT statement before it reaches D1. */
export function assertSelectOnly(sql: string): void {
  let visible = "";
  let state: "normal" | "single" | "double" | "backtick" | "bracket" | "line" | "block" = "normal";
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (state === "line") {
      if (char === "\n" || char === "\r") { state = "normal"; visible += " "; }
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") { state = "normal"; index++; visible += " "; }
      continue;
    }
    if (state !== "normal") {
      const closing = state === "single" ? "'" : state === "double" ? "\"" : state === "backtick" ? "`" : "]";
      if (char === closing) {
        if (state !== "bracket" && next === closing) { index++; continue; }
        state = "normal";
      }
      continue;
    }
    if (char === "-" && next === "-") { state = "line"; index++; visible += " "; continue; }
    if (char === "/" && next === "*") { state = "block"; index++; visible += " "; continue; }
    if (char === "'") { state = "single"; visible += " ? "; continue; }
    if (char === "\"") { state = "double"; visible += " ? "; continue; }
    if (char === "`") { state = "backtick"; visible += " ? "; continue; }
    if (char === "[") { state = "bracket"; visible += " ? "; continue; }
    visible += char;
  }
  if (state !== "normal" && state !== "line") throw new Error("D1 read query contains an unterminated quote or comment");
  let statement = visible.trim();
  if (statement.endsWith(";")) statement = statement.slice(0, -1).trimEnd();
  if (statement.includes(";") || !/^SELECT\b/i.test(statement)) {
    throw new Error("D1 REST adapter permits exactly one SELECT statement");
  }
}

class RestD1Bound implements D1Bound {
  constructor(private readonly client: RestD1, private readonly sql: string, private readonly values: unknown[]) {}
  async first<T>(): Promise<T | null> { return (await this.client.query<T>(this.sql, this.values)).at(0) ?? null; }
  async all<T>(): Promise<D1Result<T>> { return { results: await this.client.query<T>(this.sql, this.values) }; }
}

class RestD1Prepared implements D1Prepared {
  constructor(private readonly client: RestD1, private readonly sql: string) {}
  bind(...values: unknown[]): D1Bound { return new RestD1Bound(this.client, this.sql, values); }
}

export class RestD1 implements ReadOnlyD1 {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly endpoint: string;
  constructor(databaseId: string, private readonly options: CloudflareRestOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.endpoint = `${(options.apiBase ?? CLOUDFLARE_API_BASE).replace(/\/$/, "")}/accounts/${encodeURIComponent(options.accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
  }
  prepare(sql: string): D1Prepared {
    assertSelectOnly(sql);
    return new RestD1Prepared(this, sql);
  }
  async preflight(signal: AbortSignal): Promise<void> { await this.query("SELECT 1 AS ok", [], signal); }
  async query<T>(sql: string, params: unknown[], signal?: AbortSignal): Promise<T[]> {
    assertSelectOnly(sql);
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ sql, params }),
      ...(signal ? { signal } : {}),
    });
    const raw = await jsonResponse(response, "D1 query");
    if (!raw || typeof raw !== "object" || (raw as { success?: unknown }).success !== true
      || !Array.isArray((raw as { result?: unknown }).result) || (raw as { result: unknown[] }).result.length !== 1) {
      throw new Error(apiErrorReason(raw, "invalid D1 query response"));
    }
    const result = (raw as { result: Array<D1ApiQueryResult<T>> }).result[0]!;
    if (result.success !== true || (result.results !== undefined && !Array.isArray(result.results))) {
      throw new Error(apiErrorReason(raw, "D1 query failed"));
    }
    if (result.meta?.changed_db === true || Number(result.meta?.changes ?? 0) !== 0 || Number(result.meta?.rows_written ?? 0) !== 0) {
      throw new Error("D1 SELECT reported a write; refusing response");
    }
    return result.results ?? [];
  }
}

export class RestR2 implements ReadOnlyR2 {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly endpoint: string;
  constructor(bucketName: string, private readonly options: CloudflareRestOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.endpoint = `${(options.apiBase ?? CLOUDFLARE_API_BASE).replace(/\/$/, "")}/accounts/${encodeURIComponent(options.accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/objects`;
  }
  async get(key: string): Promise<ReadOnlyR2Object | null> {
    const encodedKey = key.split("/").map((segment) => {
      // WHATWG URL parsing normalizes dot-only path segments before fetch. The
      // official Cloudflare client rejects them for the same reason.
      if (segment === "." || segment === "..") throw new Error("R2 object key contains an unsafe dot path segment");
      return encodeURIComponent(segment);
    }).join("/");
    const response = await this.fetcher(`${this.endpoint}/${encodedKey}`, { method: "GET", headers: this.headers() });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 get status ${response.status}`);
    const bytes = await response.arrayBuffer();
    const lengthHeader = response.headers.get("content-length");
    const lastModified = response.headers.get("last-modified");
    const size = lengthHeader === null ? bytes.byteLength : Number(lengthHeader);
    if (!Number.isSafeInteger(size) || size < 0 || size !== bytes.byteLength) throw new Error("invalid R2 Content-Length");
    if (!lastModified || !Number.isFinite(Date.parse(lastModified))) throw new Error("invalid R2 Last-Modified");
    return { key, size, uploaded: lastModified, arrayBuffer: async () => bytes.slice(0) };
  }
  async list(options: { prefix: string; limit: number; cursor?: string }, signal?: AbortSignal): Promise<{
    objects: ReadOnlyR2ListObject[];
    truncated: boolean;
    cursor?: string;
  }> {
    const params = new URLSearchParams({ prefix: options.prefix, per_page: String(options.limit) });
    if (options.cursor) params.set("cursor", options.cursor);
    const response = await this.fetcher(`${this.endpoint}?${params}`, {
      method: "GET", headers: this.headers(), ...(signal ? { signal } : {}),
    });
    const raw = await jsonResponse(response, "R2 list");
    if (!raw || typeof raw !== "object" || (raw as { success?: unknown }).success !== true
      || !Array.isArray((raw as { result?: unknown }).result)) throw new Error(apiErrorReason(raw, "invalid R2 list response"));
    const info = (raw as { result_info?: unknown }).result_info;
    if (!info || typeof info !== "object") throw new Error("invalid R2 list pagination");
    const truncated = (info as { is_truncated?: unknown }).is_truncated === true;
    const cursor = (info as { cursor?: unknown }).cursor;
    if (truncated && (typeof cursor !== "string" || cursor.length === 0)) throw new Error("truncated R2 page omitted cursor");
    const objects = (raw as { result: unknown[] }).result.map((value): ReadOnlyR2ListObject => {
      if (!value || typeof value !== "object") throw new Error("invalid R2 list object");
      const object = value as { key?: unknown; size?: unknown; last_modified?: unknown };
      if (typeof object.key !== "string" || !Number.isSafeInteger(object.size) || Number(object.size) < 0
        || typeof object.last_modified !== "string" || !Number.isFinite(Date.parse(object.last_modified))) {
        throw new Error("invalid R2 list object");
      }
      return { key: object.key, size: Number(object.size), uploaded: object.last_modified };
    });
    return { objects, truncated, ...(truncated ? { cursor: cursor as string } : {}) };
  }
  async preflight(signal: AbortSignal): Promise<void> { await this.list({ prefix: "", limit: 1 }, signal); }
  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.apiToken}`,
      ...(this.options.jurisdiction ? { "cf-r2-jurisdiction": this.options.jurisdiction } : {}),
    };
  }
}

export interface StorageTruthLiveDependencies {
  db: ReadOnlyD1;
  bucket: ReadOnlyR2;
  apiBase: string;
  platformSecret: string;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
  close?: () => Promise<void> | void;
}

interface RootsCursor {
  v: 1;
  fromSha: string;
  fromSeq: string;
  fromGapSeq: string;
}

interface DoDropped { sha: string; lastSeq: number }
interface DoSeqRoot { seq: number; manifestSha: string; carrierSha?: string }
interface DoGap extends DoSeqRoot {
  inlineRefs?: string[];
  chainRefs?: string[];
  sidecar?: { sha: string; count: number; size: number };
}
interface InspectBody {
  head: number;
  pruneFloor: number;
  indexGeneration: number;
  droppedPage: DoDropped[];
  seqRootsPage: DoSeqRoot[];
  gapPage: DoGap[];
  nextSha?: string;
  nextSeq?: number;
  nextGapSeq?: number;
  createdAtBySequence: Record<string, number | null>;
}

type CursorKind = "workspaces" | "catalog" | "inventory" | "r2" | "fleet";

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeObject(raw: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(raw) || Buffer.from(raw, "base64url").toString("base64url") !== raw) throw new Error("invalid opaque cursor");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid opaque cursor");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid opaque cursor");
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validStreamCursor(value: unknown, sha = false): value is string {
  return typeof value === "string" && (value === "" || value === "done" || (sha ? SHA_RE.test(value) : /^\d+$/.test(value)));
}

export function encodeRootsCursor(cursor: RootsCursor): string {
  return encode({ ...cursor });
}

export function decodeRootsCursor(raw: string): RootsCursor {
  const value = decodeObject(raw);
  if (!exact(value, ["v", "fromSha", "fromSeq", "fromGapSeq"]) || value.v !== ROOT_CURSOR_VERSION
    || !validStreamCursor(value.fromSha, true) || !validStreamCursor(value.fromSeq) || !validStreamCursor(value.fromGapSeq)) {
    throw new Error("invalid roots cursor");
  }
  return value as unknown as RootsCursor;
}

function encodeKeyset(kind: CursorKind, fields: Record<string, unknown>): string {
  return encode({ v: 1, kind, ...fields });
}

function decodeKeyset(raw: string | null, kind: CursorKind, fields: string[]): Record<string, unknown> | null {
  if (raw === null) return null;
  const value = decodeObject(raw);
  if (!exact(value, ["v", "kind", ...fields]) || value.v !== 1 || value.kind !== kind) throw new Error(`invalid ${kind} cursor`);
  return value;
}

function pageLimit(requested: number, cap = MAX_D1_PAGE): number {
  if (!Number.isInteger(requested) || requested < 1) throw new Error("invalid page limit");
  return Math.min(requested, cap);
}

function triple(body: InspectBody): SnapshotTriple | null {
  const values = [body.head, body.pruneFloor, body.indexGeneration];
  if (!values.every((value) => Number.isInteger(value) && value >= 0) || body.pruneFloor > body.head) return null;
  return { head: body.head, pruneFloor: body.pruneFloor, indexGeneration: body.indexGeneration };
}

function sameTriple(a: SnapshotTriple, b: SnapshotTriple): boolean {
  return a.head === b.head && a.pruneFloor === b.pruneFloor && a.indexGeneration === b.indexGeneration;
}

function failureReason(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object") return fallback;
  const body = value as Record<string, unknown>;
  return [body.error, body.reason].filter((part): part is string => typeof part === "string").join(":") || fallback;
}

function requireSha(value: unknown): string {
  if (typeof value !== "string" || !SHA_RE.test(value)) throw new Error("invalid root sha");
  return value;
}

function requireShaArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("invalid root sha array");
  return value.map(requireSha);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${label}`);
  return value;
}

function timestamp(body: InspectBody, sequence: number): number | null {
  const value = body.createdAtBySequence?.[String(sequence)];
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid timestamp for sequence ${sequence}`);
  return value;
}

function blobKey(sha: string): string {
  return `blobs/sha256/${sha.slice(0, 2)}/${sha}`;
}

function uploadedAt(value: Date | string): number {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(result)) throw new Error("invalid R2 uploaded timestamp");
  return result;
}

export class BindingStorageTruthSource implements StorageTruthSource {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly clock: () => number;
  private fleetDb?: Database;
  private fleetBuild?: Promise<void>;
  private fleetDir?: string;
  private closed = false;

  constructor(private readonly deps: StorageTruthLiveDependencies) {
    if (!deps.apiBase || !deps.platformSecret) throw new Error("apiBase and platformSecret are required");
    this.fetcher = deps.fetch ?? globalThis.fetch;
    this.clock = deps.clock ?? Date.now;
  }

  now(): number { return this.clock(); }

  async account(accountId: string): Promise<{ usedBytes: number; retentionDays: number }> {
    const row = await this.deps.db.prepare("SELECT used_bytes,plan FROM accounts WHERE id = ?").bind(accountId)
      .first<{ used_bytes: number; plan: string | null }>();
    if (!row) throw new Error("account not found");
    return { usedBytes: Number(row.used_bytes), retentionDays: planFor(row.plan).retentionDays };
  }

  async workspaces(accountId: string, cursor: string | null, requested: number): Promise<Page<WorkspaceKey>> {
    const limit = pageLimit(requested);
    const decoded = decodeKeyset(cursor, "workspaces", ["workspaceId", "projectId"]);
    const workspaceId = decoded === null ? "" : requireString(decoded.workspaceId, "workspace cursor");
    const projectId = decoded === null ? "" : requireString(decoded.projectId, "project cursor");
    const result = await this.deps.db.prepare(`SELECT workspace_id,project_id FROM workspaces WHERE account_id = ?
      AND (workspace_id > ? OR (workspace_id = ? AND project_id > ?)) ORDER BY workspace_id,project_id LIMIT ?`)
      .bind(accountId, workspaceId, workspaceId, projectId, limit + 1)
      .all<{ workspace_id: string; project_id: string }>();
    const page = (result.results ?? []).slice(0, limit);
    const rows = page.map((row) => ({ workspaceId: row.workspace_id, projectId: row.project_id }));
    const last = page.at(-1);
    return { rows, nextCursor: (result.results?.length ?? 0) > limit && last ? encodeKeyset("workspaces", { workspaceId: last.workspace_id, projectId: last.project_id }) : null };
  }

  async roots(workspace: WorkspaceKey, cursor: string | null, pin: SnapshotTriple | null, requested: number): Promise<RootsPage> {
    const state: RootsCursor = cursor === null
      ? { v: 1, fromSha: "", fromSeq: "", fromGapSeq: "" }
      : decodeRootsCursor(cursor);
    const params = new URLSearchParams({
      ws: workspace.workspaceId,
      proj: workspace.projectId,
      fromSha: state.fromSha,
      fromSeq: state.fromSeq,
      fromGapSeq: state.fromGapSeq,
      limit: String(pageLimit(requested, 20_000)),
    });
    if (pin) {
      params.set("pinHead", String(pin.head));
      params.set("pinFloor", String(pin.pruneFloor));
      params.set("pinGen", String(pin.indexGeneration));
    }
    let response: Response;
    try {
      response = await this.fetcher(`${this.deps.apiBase.replace(/\/$/, "")}/v1/admin/roots-inspect?${params}`, {
        method: "GET",
        headers: { "x-rbox-platform": this.deps.platformSecret },
      });
    } catch (error) {
      return { outcome: "uninspectable", reason: `roots request failed:${error instanceof Error ? error.name : typeof error}` };
    }
    let raw: unknown;
    try { raw = await response.json(); } catch { raw = null; }
    if (response.status === 409) {
      const error = raw && typeof raw === "object" ? (raw as Record<string, unknown>).error : undefined;
      return error === "snapshot_changed"
        ? { outcome: "snapshot_changed", reason: "snapshot changed" }
        : { outcome: "uninspectable", reason: failureReason(raw, "roots conflict") };
    }
    if (!response.ok) return { outcome: "uninspectable", reason: failureReason(raw, `roots status ${response.status}`) };

    try {
      const body = raw as InspectBody;
      if (!body || typeof body !== "object" || !Array.isArray(body.droppedPage) || !Array.isArray(body.seqRootsPage)
        || !Array.isArray(body.gapPage) || !body.createdAtBySequence || typeof body.createdAtBySequence !== "object") {
        throw new Error("invalid roots response");
      }
      const observed = triple(body);
      if (!observed) throw new Error("invalid snapshot triple");
      if (pin && !sameTriple(pin, observed)) return { outcome: "snapshot_changed", reason: "snapshot triple changed" };

      const entries: RootEntry[] = [];
      const add = (sha: unknown, head: boolean, sequence: number): void => {
        if (!Number.isInteger(sequence) || sequence < 1) throw new Error("invalid root sequence");
        entries.push({ sha: requireSha(sha), head, sequence, committedAt: timestamp(body, sequence) });
      };
      for (const row of body.droppedPage) add(row.sha, false, Number(row.lastSeq));
      for (const row of body.seqRootsPage) {
        const sequence = Number(row.seq);
        add(row.manifestSha, sequence === observed.head, sequence);
        if (row.carrierSha !== undefined) add(row.carrierSha, sequence === observed.head, sequence);
      }
      for (const row of body.gapPage) {
        const sequence = Number(row.seq);
        const isHead = sequence === observed.head;
        add(row.manifestSha, isHead, sequence);
        if (row.carrierSha !== undefined) add(row.carrierSha, isHead, sequence);
        for (const sha of requireShaArray(row.inlineRefs)) add(sha, isHead, sequence);
        for (const sha of requireShaArray(row.chainRefs)) add(sha, isHead, sequence);
        if (row.sidecar !== undefined) {
          if (row.carrierSha !== row.sidecar.sha) throw new Error("sidecar carrier mismatch");
          const refs = await this.expandSidecar(row.sidecar);
          for (const sha of refs) add(sha, isHead, sequence);
        }
      }

      const next: RootsCursor = {
        v: 1,
        fromSha: state.fromSha === "done" ? "done" : body.nextSha === undefined ? "done" : requireSha(body.nextSha),
        fromSeq: state.fromSeq === "done" ? "done" : body.nextSeq === undefined ? "done" : this.numericCursor(body.nextSeq),
        fromGapSeq: state.fromGapSeq === "done" ? "done" : body.nextGapSeq === undefined ? "done" : this.numericCursor(body.nextGapSeq),
      };
      const done = next.fromSha === "done" && next.fromSeq === "done" && next.fromGapSeq === "done";
      return {
        outcome: "ok",
        triple: observed,
        entries,
        nextCursor: done ? null : encodeRootsCursor(next),
        droppedRows: body.droppedPage.length,
        seqRootRows: body.seqRootsPage.length,
      };
    } catch (error) {
      return { outcome: "uninspectable", reason: error instanceof Error ? error.message : "invalid roots response" };
    }
  }

  async currentHead(workspace: WorkspaceKey): Promise<{ outcome: "ok" | "uninspectable"; head?: number; reason?: string }> {
    const cursor = encodeRootsCursor({ v: 1, fromSha: "done", fromSeq: "done", fromGapSeq: "done" });
    const page = await this.roots(workspace, cursor, null, 1);
    if (page.outcome !== "ok" || !page.triple) {
      return { outcome: "uninspectable", reason: `current head unavailable: ${page.reason ?? page.outcome}` };
    }
    return { outcome: "ok", head: page.triple.head };
  }

  async catalog(cursor: string | null, requested: number): Promise<Page<CatalogRow>> {
    const limit = pageLimit(requested);
    const decoded = decodeKeyset(cursor, "catalog", ["sha"]);
    const after = decoded === null ? "" : requireSha(decoded.sha);
    const result = await this.deps.db.prepare("SELECT sha256,size_bytes FROM blobs WHERE sha256 > ? ORDER BY sha256 LIMIT ?")
      .bind(after, limit + 1).all<{ sha256: string; size_bytes: number }>();
    const page = (result.results ?? []).slice(0, limit);
    const rows = page.map((row) => ({ sha: requireSha(row.sha256), sizeBytes: Number(row.size_bytes) }));
    const last = page.at(-1);
    return { rows, nextCursor: (result.results?.length ?? 0) > limit && last ? encodeKeyset("catalog", { sha: last.sha256 }) : null };
  }

  async entitlements(accountId: string, cursor: { accountId: string; sha: string } | null, requested: number): Promise<Page<EntitlementRow>> {
    const limit = pageLimit(requested);
    if (cursor && (cursor.accountId !== accountId || !SHA_RE.test(cursor.sha))) throw new Error("invalid entitlement cursor");
    const after = cursor?.sha ?? "";
    const result = await this.deps.db.prepare(`SELECT r.account_id,r.sha256,r.granted_at,c.marked_at,b.size_bytes,
        l.pack_id,l.length,CASE WHEN l.sha256 IS NULL THEN NULL ELSE EXISTS(
          SELECT 1 FROM packs p JOIN pack_members m ON m.pack_id=p.pack_id
          WHERE p.pack_id=l.pack_id AND p.state='ready' AND m.sha256=l.sha256
        ) END AS pack_inventory_present
      FROM blob_refs r LEFT JOIN blob_ref_candidates c ON c.account_id=r.account_id AND c.sha256=r.sha256
      LEFT JOIN blobs b ON b.sha256=r.sha256 LEFT JOIN blob_locations l ON l.sha256=r.sha256
      WHERE r.account_id=? AND r.sha256>? ORDER BY r.sha256 LIMIT ?`)
      .bind(accountId, after, limit + 1).all<Record<string, unknown>>();
    const page = (result.results ?? []).slice(0, limit);
    const rows = page.map((row): EntitlementRow => ({
      accountId: String(row.account_id), sha: requireSha(row.sha256), grantedAt: Number(row.granted_at),
      markedAt: row.marked_at == null ? null : Number(row.marked_at),
      sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
      location: row.pack_id == null ? null : {
        packId: String(row.pack_id), length: Number(row.length), packInventoryPresent: Number(row.pack_inventory_present) === 1,
      },
    }));
    const last = rows.at(-1);
    return { rows, nextCursor: (result.results?.length ?? 0) > limit && last ? `${last.accountId}\n${last.sha}` : null };
  }

  async inventory(prefix: "canonical" | "pack", cursor: string | null, requested: number): Promise<Page<InventoryEntry>> {
    return prefix === "canonical" ? this.canonicalInventory(cursor, requested) : this.packInventory(cursor, requested);
  }

  async r2(prefix: "canonical" | "pack", cursor: string | null, requested: number): Promise<Page<ObservedObject>> {
    const limit = pageLimit(requested, MAX_R2_PAGE);
    const decoded = decodeKeyset(cursor, "r2", ["prefix", "cursor"]);
    if (decoded && decoded.prefix !== prefix) throw new Error("R2 cursor prefix mismatch");
    const remoteCursor = decoded === null ? undefined : requireString(decoded.cursor, "R2 cursor");
    const listed = await this.deps.bucket.list({
      prefix: prefix === "canonical" ? "blobs/sha256/" : "packs/v1/",
      limit,
      ...(remoteCursor ? { cursor: remoteCursor } : {}),
    });
    if (listed.objects.length > limit) throw new Error("R2 page exceeded requested limit");
    const rows = listed.objects.map((object) => ({ key: object.key, sizeBytes: Number(object.size), uploadedAt: uploadedAt(object.uploaded) }));
    if (listed.truncated && !listed.cursor) throw new Error("truncated R2 page omitted cursor");
    return { rows, nextCursor: listed.truncated ? encodeKeyset("r2", { prefix, cursor: listed.cursor! }) : null };
  }

  async catalogGrantedBytes(startedAt: number, endedAt: number): Promise<number> {
    const row = await this.deps.db.prepare(`SELECT COALESCE(SUM(COALESCE(b.size_bytes,0)),0) bytes FROM blob_refs r
      LEFT JOIN blobs b ON b.sha256=r.sha256 WHERE r.granted_at>? AND r.granted_at<=?`)
      .bind(startedAt, endedAt).first<{ bytes: number }>();
    return Number(row?.bytes ?? 0);
  }

  async inventoryChangedBytes(startedAt: number, endedAt: number): Promise<number> {
    const canonical = await this.deps.db.prepare(`SELECT COALESCE(SUM(b.size_bytes),0) bytes FROM blobs b
      LEFT JOIN gc_candidates c ON c.sha256=b.sha256 LEFT JOIN blob_locations l ON l.sha256=b.sha256
      WHERE (l.sha256 IS NULL AND ((unixepoch(b.created_at)*1000)>? AND (unixepoch(b.created_at)*1000)<=?
        OR c.marked_at>? AND c.marked_at<=? OR c.deleting_at>? AND c.deleting_at<=?))
        OR (l.installed_at>? AND l.installed_at<=?)`)
      .bind(startedAt, endedAt, startedAt, endedAt, startedAt, endedAt, startedAt, endedAt).first<{ bytes: number }>();
    const packs = await this.deps.db.prepare(`SELECT COALESCE(SUM(p.size_bytes),0) bytes FROM packs p
      LEFT JOIN pack_gc_candidates c ON c.pack_id=p.pack_id
      WHERE (p.touched_at>? AND p.touched_at<=?) OR (c.marked_at>? AND c.marked_at<=?) OR (c.deleting_at>? AND c.deleting_at<=?)`)
      .bind(startedAt, endedAt, startedAt, endedAt, startedAt, endedAt).first<{ bytes: number }>();
    return Number(canonical?.bytes ?? 0) + Number(packs?.bytes ?? 0);
  }

  async fleetReachability(cursor: string | null, requested: number): Promise<Page<FleetReachabilityRow>> {
    await this.ensureFleet();
    const limit = pageLimit(requested);
    const decoded = decodeKeyset(cursor, "fleet", ["sha"]);
    const after = decoded === null ? "" : requireSha(decoded.sha);
    const rows = this.fleetDb!.query(`SELECT sha,MAX(active) active FROM fleet_roots WHERE sha>? GROUP BY sha ORDER BY sha LIMIT ?`)
      .all(after, limit + 1) as Array<{ sha: string; active: number }>;
    const page = rows.slice(0, limit);
    const mapped = page.map((row) => ({ sha: row.sha, active: Number(row.active) === 1, retained: true }));
    const last = page.at(-1);
    return { rows: mapped, nextCursor: rows.length > limit && last ? encodeKeyset("fleet", { sha: last.sha }) : null };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // If a build is already running, let it settle before closing its database. A
    // rejected build is still followed by best-effort local/proxy cleanup.
    await this.fleetBuild?.catch(() => {});
    this.fleetDb?.close();
    this.fleetDb = undefined;
    if (this.fleetDir) await rm(this.fleetDir, { recursive: true, force: true });
    this.fleetDir = undefined;
    await this.deps.close?.();
  }

  private numericCursor(value: unknown): string {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) throw new Error("invalid numeric roots cursor");
    return String(number);
  }

  private async expandSidecar(descriptor: { sha: string; count: number; size: number }): Promise<string[]> {
    const sha = requireSha(descriptor.sha);
    if (!Number.isInteger(descriptor.count) || descriptor.count < 0 || descriptor.count > MAX_SIDECAR_REFS
      || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0) throw new Error("invalid sidecar descriptor");
    const object = await this.deps.bucket.get(blobKey(sha));
    if (!object) throw new Error("sidecar missing");
    if (object.key !== blobKey(sha)) throw new Error("sidecar key mismatch");
    const expectedLength = refsetByteLength(descriptor.count);
    if (object.size !== expectedLength) throw new Error("sidecar length mismatch");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== expectedLength) throw new Error("sidecar body length mismatch");
    if (createHash("sha256").update(bytes).digest("hex") !== sha) throw new Error("sidecar sha mismatch");
    const refs = parseRefset(bytes);
    if (refs.length !== descriptor.count) throw new Error("sidecar count mismatch");
    const totalBytes = refs.reduce((sum, ref) => sum + ref.size, 0);
    if (totalBytes !== descriptor.size) throw new Error("sidecar descriptor size mismatch");
    return refs.map((ref) => ref.encSha);
  }

  private async canonicalInventory(cursor: string | null, requested: number): Promise<Page<InventoryEntry>> {
    const limit = pageLimit(requested);
    const decoded = decodeKeyset(cursor, "inventory", ["prefix", "key"]);
    if (decoded && decoded.prefix !== "canonical") throw new Error("inventory cursor prefix mismatch");
    const after = decoded === null ? "" : requireSha(decoded.key);
    const result = await this.deps.db.prepare(`SELECT b.sha256,b.size_bytes,b.present,c.marked_at,c.deleting_at,
        unixepoch(b.created_at)*1000 AS created_at_ms FROM blobs b
      LEFT JOIN gc_candidates c ON c.sha256=b.sha256 LEFT JOIN blob_locations l ON l.sha256=b.sha256
      WHERE l.sha256 IS NULL AND b.sha256>? ORDER BY b.sha256 LIMIT ?`)
      .bind(after, limit + 1).all<Record<string, unknown>>();
    const page = (result.results ?? []).slice(0, limit);
    const rows = page.map((row): InventoryEntry => {
      const condemned = row.marked_at != null;
      const ready = Number(row.present) === 1;
      const lifecycle = condemned ? "condemned" : ready ? "ready" : "staging";
      const changedAt = Math.max(Number(row.created_at_ms ?? 0), Number(row.marked_at ?? 0), Number(row.deleting_at ?? 0));
      return {
        key: blobKey(requireSha(row.sha256)), sizeBytes: Number(row.size_bytes), lifecycle,
        rawState: condemned ? (row.deleting_at == null ? "gc-marked" : "gc-deleting") : ready ? "present=1" : "present=0",
        expectedPresence: lifecycle === "ready", ...(changedAt > 0 ? { changedAt } : {}),
      };
    });
    const last = page.at(-1);
    return { rows, nextCursor: (result.results?.length ?? 0) > limit && last ? encodeKeyset("inventory", { prefix: "canonical", key: last.sha256 }) : null };
  }

  private async packInventory(cursor: string | null, requested: number): Promise<Page<InventoryEntry>> {
    const limit = pageLimit(requested, MAX_PACK_PAGE);
    const decoded = decodeKeyset(cursor, "inventory", ["prefix", "key"]);
    if (decoded && decoded.prefix !== "pack") throw new Error("inventory cursor prefix mismatch");
    const after = decoded === null ? "" : requireString(decoded.key, "pack inventory cursor");
    const result = await this.deps.db.prepare(`SELECT p.pack_id,p.size_bytes,p.state,p.created_at,p.touched_at,c.marked_at,c.deleting_at
      FROM packs p LEFT JOIN pack_gc_candidates c ON c.pack_id=p.pack_id WHERE p.pack_id>? ORDER BY p.pack_id LIMIT ?`)
      .bind(after, limit + 1).all<Record<string, unknown>>();
    const page = (result.results ?? []).slice(0, limit);
    const ids = page.map((row) => String(row.pack_id));
    const members = new Map<string, string[]>();
    if (ids.length > 0) {
      const memberRows = await this.deps.db.prepare(`SELECT pack_id,sha256 FROM pack_members
        WHERE pack_id IN (SELECT value FROM json_each(?)) ORDER BY pack_id,sha256`)
        .bind(JSON.stringify(ids)).all<{ pack_id: string; sha256: string }>();
      for (const member of memberRows.results ?? []) {
        const list = members.get(member.pack_id) ?? [];
        list.push(requireSha(member.sha256));
        members.set(member.pack_id, list);
      }
    }
    const rows = page.map((row): InventoryEntry => {
      const packId = String(row.pack_id);
      const candidate = row.marked_at != null;
      const state = String(row.state);
      const lifecycle = candidate || state === "swept" ? "condemned" : state === "ready" ? "ready" : "staging";
      const changedAt = Math.max(Number(row.created_at ?? 0), Number(row.touched_at ?? 0), Number(row.marked_at ?? 0), Number(row.deleting_at ?? 0));
      return {
        key: `packs/v1/${packId}`, sizeBytes: Number(row.size_bytes), lifecycle,
        rawState: candidate ? (row.deleting_at == null ? "gc-marked" : "gc-deleting") : state,
        expectedPresence: lifecycle === "ready", changedAt,
        members: (members.get(packId) ?? []).map((sha) => ({ sha })),
      };
    });
    const last = page.at(-1);
    return { rows, nextCursor: (result.results?.length ?? 0) > limit && last ? encodeKeyset("inventory", { prefix: "pack", key: last.pack_id }) : null };
  }

  private async ensureFleet(): Promise<void> {
    if (this.closed) throw new Error("storage-truth source is closed");
    if (this.fleetBuild) return this.fleetBuild;
    this.fleetBuild = (async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "rbox-storage-truth-fleet-"));
      this.fleetDir = directory;
      this.fleetDb = new Database(path.join(directory, "reachability.sqlite"));
      this.fleetDb.exec("CREATE TABLE fleet_roots(workspace TEXT NOT NULL,sha TEXT NOT NULL,active INTEGER NOT NULL,PRIMARY KEY(workspace,sha)); CREATE INDEX fleet_roots_sha ON fleet_roots(sha)");
      const insert = this.fleetDb.prepare(`INSERT INTO fleet_roots VALUES(?,?,?) ON CONFLICT(workspace,sha)
        DO UPDATE SET active=MAX(active,excluded.active)`);
      let workspaceCursor: { workspaceId: string; projectId: string } | null = null;
      for (;;) {
        const result: D1Result<{ workspace_id: string; project_id: string }> = await this.deps.db.prepare(`SELECT workspace_id,project_id FROM workspaces
          WHERE workspace_id>? OR (workspace_id=? AND project_id>?) ORDER BY workspace_id,project_id LIMIT 101`)
          .bind(workspaceCursor?.workspaceId ?? "", workspaceCursor?.workspaceId ?? "", workspaceCursor?.projectId ?? "")
          .all<{ workspace_id: string; project_id: string }>();
        const page: Array<{ workspace_id: string; project_id: string }> = (result.results ?? []).slice(0, 100);
        for (const row of page) {
          const workspace = { workspaceId: row.workspace_id, projectId: row.project_id };
          const key = `${workspace.workspaceId}\n${workspace.projectId}`;
          let complete = false;
          for (let attempt = 0; attempt <= FLEET_SNAPSHOT_RETRIES && !complete; attempt++) {
            this.fleetDb.prepare("DELETE FROM fleet_roots WHERE workspace=?").run(key);
            let cursor: string | null = null;
            let pin: SnapshotTriple | null = null;
            for (;;) {
              const roots = await this.roots(workspace, cursor, pin, 20_000);
              if (roots.outcome === "snapshot_changed") break;
              if (roots.outcome !== "ok" || !roots.triple) {
                throw new WorkspaceInspectionFailure("uninspectable", workspace, roots.reason ?? "fleet roots unavailable");
              }
              pin ??= roots.triple;
              if (!sameTriple(pin, roots.triple)) break;
              this.fleetDb.transaction(() => {
                for (const root of roots.entries ?? []) insert.run(key, root.sha, root.head ? 1 : 0);
              })();
              cursor = roots.nextCursor ?? null;
              if (cursor === null) { complete = true; break; }
            }
            if (!complete && attempt === FLEET_SNAPSHOT_RETRIES) {
              throw new WorkspaceInspectionFailure("stale-pin", workspace, "fleet roots snapshot changed after three retries");
            }
          }
        }
        if ((result.results?.length ?? 0) <= 100) break;
        const last: { workspace_id: string; project_id: string } = page.at(-1)!;
        workspaceCursor = { workspaceId: last.workspace_id, projectId: last.project_id };
      }
    })();
    return this.fleetBuild;
  }
}

export function createStorageTruthSource(dependencies: StorageTruthLiveDependencies): BindingStorageTruthSource {
  return new BindingStorageTruthSource(dependencies);
}

export function resolveStorageTruthResources(environment: "dev" | "production"): StorageTruthResourceConfig {
  const sourceConfigPath = fileURLToPath(new URL("../apps/api/wrangler.jsonc", import.meta.url));
  const configured = unstable_readConfig({ config: sourceConfigPath, env: environment === "dev" ? undefined : environment }, { hideWarnings: true });
  const database = configured.d1_databases.find((binding) => binding.binding === "rbox_dev_db");
  const bucket = configured.r2_buckets.find((binding) => binding.binding === "rbox_dev_blobs");
  if (!database?.database_id || !bucket?.bucket_name) {
    throw new Error("selected Wrangler environment is missing the storage-truth D1/R2 bindings");
  }
  return {
    environment,
    databaseId: database.database_id,
    bucketName: bucket.bucket_name,
    ...(bucket.jurisdiction ? { bucketJurisdiction: bucket.jurisdiction } : {}),
  };
}

function safeReason(error: unknown, secrets: string[] = []): string {
  const raw = error instanceof Error
    ? error.name === "AbortError" ? "request aborted" : error.message
    : typeof error === "string" ? error : "unknown connection failure";
  return secrets.filter(Boolean).reduce((reason, secret) => reason.replaceAll(secret, "[redacted]"), raw);
}

function establishConnection(
  component: "d1-rest" | "r2-rest",
  environment: string,
  requiredEnvironment: string[],
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<void>,
  parentSignal: AbortSignal,
  secrets: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", onParentAbort);
      if (error === undefined) resolve();
      else if (error instanceof StorageTruthConnectionError) reject(error);
      else reject(new StorageTruthConnectionError(component, environment, requiredEnvironment, safeReason(error, secrets)));
    };
    const onParentAbort = (): void => {
      controller.abort(parentSignal.reason);
      finish(new StorageTruthConnectionError(component, environment, requiredEnvironment, "cancelled because another storage connection failed"));
    };
    const timer = setTimeout(() => {
      controller.abort(new Error("storage connection timed out"));
      finish(new StorageTruthConnectionError(component, environment, requiredEnvironment, "connection timed out", timeoutMs));
    }, timeoutMs);
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
    if (parentSignal.aborted) { onParentAbort(); return; }
    void Promise.resolve().then(() => operation(controller.signal)).then(() => finish(), finish);
  });
}

export interface CreateSourceOptions {
  environment?: string;
  accountId?: string;
  apiToken?: string;
  platformSecret?: string;
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
  cloudflareApiBase?: string;
  establishmentTimeoutMs?: number;
}

/** Zero-argument CLI factory consumed by `scripts/storage-truth.ts --adapter ...`. */
export async function createSource(options: CreateSourceOptions = {}): Promise<StorageTruthSource> {
  const environmentName = options.environment ?? process.env.RBOX_STORAGE_TRUTH_ENV ?? "production";
  if (environmentName !== "dev" && environmentName !== "production") {
    throw new StorageTruthConnectionError("config", environmentName, ["RBOX_STORAGE_TRUTH_ENV"], "must be dev or production");
  }
  let resources: StorageTruthResourceConfig;
  try {
    resources = resolveStorageTruthResources(environmentName);
  } catch (error) {
    throw new StorageTruthConnectionError("config", environmentName, ["RBOX_STORAGE_TRUTH_ENV"], safeReason(error));
  }
  const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? "";
  const cloudflareEnvironment = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];
  if (!apiToken || !accountId) {
    throw new StorageTruthConnectionError("d1-rest", environmentName, cloudflareEnvironment, "missing Cloudflare REST credentials");
  }
  const platformSecret = options.platformSecret ?? process.env.RBOX_PLATFORM_SECRET ?? "";
  const apiBase = options.apiBase ?? process.env.RBOX_STORAGE_TRUTH_API ?? (environmentName === "production" ? "https://api.rbox.to" : "");
  if (!platformSecret || !apiBase) {
    throw new StorageTruthConnectionError(
      "roots-inspect",
      environmentName,
      environmentName === "production" ? ["RBOX_PLATFORM_SECRET"] : ["RBOX_PLATFORM_SECRET", "RBOX_STORAGE_TRUTH_API"],
      "missing deployed roots-inspect configuration",
    );
  }
  const restOptions: CloudflareRestOptions = {
    accountId,
    apiToken,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.cloudflareApiBase ? { apiBase: options.cloudflareApiBase } : {}),
    ...(resources.bucketJurisdiction ? { jurisdiction: resources.bucketJurisdiction } : {}),
  };
  const db = new RestD1(resources.databaseId, restOptions);
  const bucket = new RestR2(resources.bucketName, restOptions);
  const parent = new AbortController();
  const timeoutMs = options.establishmentTimeoutMs ?? ESTABLISHMENT_TIMEOUT_MS;
  const d1 = establishConnection("d1-rest", environmentName, cloudflareEnvironment, timeoutMs, (signal) => db.preflight(signal), parent.signal, [apiToken]);
  const r2 = establishConnection("r2-rest", environmentName, cloudflareEnvironment, timeoutMs, (signal) => bucket.preflight(signal), parent.signal, [apiToken]);
  try {
    await Promise.all([d1, r2]);
  } catch (error) {
    parent.abort(error);
    await Promise.allSettled([d1, r2]);
    throw error;
  }
  return createStorageTruthSource({
    db,
    bucket,
    apiBase,
    platformSecret,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
