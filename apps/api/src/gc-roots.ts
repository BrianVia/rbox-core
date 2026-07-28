import type { Env } from "./env.js";
import { dbFor } from "./db.js";
import { loadSidecarRefs } from "./sidecar.js";
import { metric } from "./gc-observability.js";

// §32 FLAG: global GC (mark/purge) enumerates `workspaces`/`blobs`/`blob_refs`/
// `gc_candidates` across ALL accounts and keys the per-blob deletes by `sha256` — an
// account-data-plane CROSS-SHARD fan-out (design 32 §6b, deferred to §33). None of these
// sites has an account id in scope, so they call `dbFor(env, "")`: account-less, the one
// shard at N=1, and exactly the sites a real shard cutover must turn into a per-shard
// fan-out. Phase 2 deliberately never touches per-account usage (I4).

/**
 * Build the reachable set from AUTHORITATIVE DO roots for a set of workspaces. Asks each
 * per-(workspace, project) WorkspaceSync DO for its retained roots and unions every
 * `encManifestSha` + referenced `encSha`. Under full E2EE the DO parses each retained
 * commit body and hands back the content addresses directly, so GC needs NO R2 manifest
 * fetch and stays zero-knowledge.
 *
 * FAIL CLOSED: a single unreadable DO or exhausted bound throws, so GC never treats a
 * partial snapshot as "unreachable" and wrongly reclaims live content. Workspaces are
 * deliberately sequential so peak memory is the merged set plus one bounded local set.
 */
export const MAX_DROPPED_PAGES = 16;
export const MAX_SEQROOTS_PAGES = 4;
export const MAX_SNAPSHOT_RETRIES = 2;
export const MAX_UNIQUE_ROOTS = 750_000;
const ROOTS_PAGE_LIMIT = 20_000;

export class GcRootsCapExceeded extends Error {
  constructor() {
    super(`GC abort (fail-closed): reachable roots exceed ${MAX_UNIQUE_ROOTS}`);
    this.name = "GcRootsCapExceeded";
  }
}

interface RootsPage {
  head: number;
  pruneFloor: number;
  indexGeneration: number;
  gap: Array<{
    manifestSha: string;
    carrierSha?: string;
    inlineRefs?: string[];
    chainRefs?: string[];
    sidecar?: { sha: string; count: number; size: number };
  }>;
  droppedPage: string[];
  nextSha?: string;
  seqRootsPage: Array<{ manifestSha: string; carrierSha?: string }>;
  nextSeq?: number;
}

function addRoot(env: Env, global: Set<string>, local: Set<string>, sha: string): void {
  if (!sha || local.has(sha) || global.has(sha)) return;
  if (global.size + local.size >= MAX_UNIQUE_ROOTS) {
    metric(env, "gc.roots.cardinality_exceeded", global.size + local.size + 1, 0, "fail_closed");
    throw new GcRootsCapExceeded();
  }
  local.add(sha);
}

export async function reachableFromWorkspaces(env: Env, rows: Array<{ workspace_id: string; project_id: string }>): Promise<Set<string>> {
  const reachable = new Set<string>();
  for (const w of rows) {
    let complete: Set<string> | null = null;
    for (let attempt = 0; attempt <= MAX_SNAPSHOT_RETRIES && !complete; attempt++) {
      const local = new Set<string>();
      const id = env.WORKSPACE_SYNC.idFromName(`${w.workspace_id}/${w.project_id}`);
      // Slash-safe addressing (design 37 §4f follow-up): a positional `…/proj/:proj/roots` path
      // mis-parses a project_id containing "/" → 404 → the fail-closed sweep reclaims NOTHING
      // (indefinite leak of blobs the account-deletion path condemned). Use the DO's FIXED
      // `/roots` path with ws/proj in the query instead.
      let fromSha = "";
      let fromSeq = "";
      let droppedPages = 0;
      let seqRootsPages = 0;
      let gapRead = false;
      let pin: Pick<RootsPage, "head" | "pruneFloor" | "indexGeneration"> | null = null;
      try {
        while (fromSha !== "done" || fromSeq !== "done") {
          if (fromSha !== "done" && ++droppedPages > MAX_DROPPED_PAGES) throw new Error("dropped-page cap exceeded");
          if (fromSeq !== "done" && ++seqRootsPages > MAX_SEQROOTS_PAGES) throw new Error("seq-roots-page cap exceeded");
          const q = new URLSearchParams({ ws: w.workspace_id, proj: w.project_id, fromSha, fromSeq, limit: String(ROOTS_PAGE_LIMIT) });
          if (pin) {
            q.set("pinHead", String(pin.head));
            q.set("pinFloor", String(pin.pruneFloor));
            q.set("pinGen", String(pin.indexGeneration));
          }
          const res = await env.WORKSPACE_SYNC.get(id).fetch(`https://do/roots?${q}`);
          if (res.status === 409) throw new DOMException("snapshot changed", "AbortError");
          if (!res.ok) throw new Error(`roots status ${res.status}`);
          const page = (await res.json()) as RootsPage;
          pin ??= page;
          for (const sha of page.droppedPage) addRoot(env, reachable, local, sha);
          for (const root of page.seqRootsPage) {
            addRoot(env, reachable, local, root.manifestSha);
            if (root.carrierSha) addRoot(env, reachable, local, root.carrierSha);
          }
          if (!gapRead) {
            for (const gap of page.gap) {
              addRoot(env, reachable, local, gap.manifestSha);
              if (gap.carrierSha) addRoot(env, reachable, local, gap.carrierSha);
              for (const sha of gap.inlineRefs ?? []) addRoot(env, reachable, local, sha);
              for (const sha of gap.chainRefs ?? []) addRoot(env, reachable, local, sha);
              if (gap.sidecar) {
                addRoot(env, reachable, local, gap.sidecar.sha);
                const loaded = await loadSidecarRefs(env, gap.sidecar.sha, gap.sidecar.count);
                if (!loaded.ok) throw new Error(`gap sidecar ${loaded.reason}`);
                let totalBytes = 0;
                for (const ref of loaded.refs) totalBytes += ref.size;
                if (totalBytes !== gap.sidecar.size) throw new Error("gap sidecar descriptor size mismatch");
                for (const ref of loaded.refs) addRoot(env, reachable, local, ref.encSha);
              }
            }
            gapRead = true;
          }
          fromSha = fromSha === "done" ? "done" : page.nextSha ?? "done";
          fromSeq = fromSeq === "done" ? "done" : page.nextSeq == null ? "done" : String(page.nextSeq);
        }
        complete = local;
      } catch (e) {
        local.clear(); // release the partial workspace accumulator before a retry
        if (e instanceof GcRootsCapExceeded) throw e;
        if (e instanceof DOMException && e.name === "AbortError" && attempt < MAX_SNAPSHOT_RETRIES) continue;
        throw new Error(`GC abort (fail-closed): cannot read roots for ${w.workspace_id}/${w.project_id}`, { cause: e });
      }
    }
    for (const sha of complete!) reachable.add(sha);
  }
  return reachable;
}

export async function workspaceSnapshot(env: Env, maxW: number): Promise<Array<{ workspace_id: string; project_id: string }> | null> {
  const rows = await dbFor(env, "")
    .prepare("SELECT workspace_id, project_id FROM workspaces LIMIT ?")
    .bind(maxW + 1)
    .all<{ workspace_id: string; project_id: string }>();
  const results = rows.results ?? [];
  if (results.length > maxW) {
    metric(env, "gc.budget_exceeded", results.length, 0, "workspaces");
    return null;
  }
  return results;
}

export async function exactWorkspaceCount(env: Env): Promise<number> {
  const row = await dbFor(env, "").prepare("SELECT COUNT(*) AS n FROM workspaces").first<{ n: number }>();
  return Number(row?.n ?? 0);
}
