/**
 * The "track an existing workspace" picker (Feature B) — PURE logic plus the tiny
 * display helpers `rbox status` shares. The only I/O here is the thin
 * `fetchAccountWorkspaces` HTTP helper; everything the picker's behavior turns on
 * (sorting, labelling, rendering the numbered list, resolving a typed pick) is
 * pure and TTY-free, so it's unit-tested without a server or a terminal.
 *
 * It replaces the old "paste a workspace id copied from another machine" prompt:
 * the CLI already knows the account's workspaces, so it lists them and lets the
 * user pick a number — while KEEPING a manual-id fallback for cross-account /
 * edge cases and the scripted `--workspace <id>` path.
 */

/** One row of `GET /v1/account/workspaces` (E2EE: the server holds no path — `name`
 *  is the opt-in dashboard label, null unless the creating host set one). */
export interface AccountWorkspace {
  workspaceId: string;
  projectId: string;
  name: string | null;
  createdAt: number; // epoch ms
}

/** Shorten an opaque `ws_<hex>` id for display: keep the `ws_` prefix + a readable
 *  slice of the entropy (e.g. `ws_ab12cd34`). Non-conforming ids pass through. */
export function shortWorkspaceId(id: string): string {
  const m = /^([a-z]+_)(.+)$/i.exec(id);
  if (!m) return id.length <= 11 ? id : `${id.slice(0, 11)}…`;
  const [, prefix, body] = m as unknown as [string, string, string];
  return body.length <= 8 ? id : `${prefix}${body.slice(0, 8)}`;
}

/** A compact, human relative age like `just now`, `21h ago`, `3d ago`. Used both by
 *  the picker rows and any caller wanting a fallback label. `nowMs` is injected so
 *  the formatting stays pure/testable (no `Date.now()` inside). */
export function relativeAge(createdAtMs: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

/** The primary label for a workspace: its opt-in name, else the short id. */
export function workspacePickLabel(ws: AccountWorkspace): string {
  return ws.name ?? shortWorkspaceId(ws.workspaceId);
}

/** Newest-first — the order the picker renders. Non-mutating. */
export function sortWorkspacesForPick(list: AccountWorkspace[]): AccountWorkspace[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Render an ALREADY-SORTED workspace list as aligned, numbered menu lines (plain
 * text — the caller adds any styling). 1-based, name-or-fallback in an aligned
 * column, with a `· created <ago>` suffix on every row. Returns [] for an empty
 * list (the caller handles the empty case).
 */
export function renderWorkspacePickList(sorted: AccountWorkspace[], nowMs: number): string[] {
  if (sorted.length === 0) return [];
  const labels = sorted.map(workspacePickLabel);
  const width = Math.max(...labels.map((l) => l.length));
  const idxWidth = String(sorted.length).length;
  return sorted.map((ws, i) => {
    const n = String(i + 1).padStart(idxWidth);
    return `  ${n}  ${labels[i]!.padEnd(width)}   · created ${relativeAge(ws.createdAt, nowMs)}`;
  });
}

/** What a typed picker answer resolves to: a concrete workspace, the manual-entry
 *  escape hatch, or `null` for an unrecognized answer (caller re-prompts). */
export type PickResolution =
  | { kind: "pick"; workspaceId: string; name: string | null }
  | { kind: "manual" };

/**
 * Resolve a user's typed answer against an ALREADY-SORTED list. A 1-based number
 * in range picks that workspace (carrying its name for the local cache); `m` /
 * `manual` / `paste` chooses manual id entry; anything else is `null` (re-prompt).
 */
export function resolveWorkspacePick(sorted: AccountWorkspace[], input: string): PickResolution | null {
  const s = input.trim().toLowerCase();
  if (s === "m" || s === "manual" || s === "paste") return { kind: "manual" };
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (n < 1 || n > sorted.length) return null;
  const ws = sorted[n - 1]!;
  return { kind: "pick", workspaceId: ws.workspaceId, name: ws.name };
}

/**
 * Fetch ALL of the caller's workspaces, following the keyset cursor. Bounded by
 * `maxPages` so a pathological account can't spin forever — the picker only needs
 * enough to choose from, not an exhaustive dump. Throws on a non-2xx so `setup`
 * can degrade to manual entry.
 */
export async function fetchAccountWorkspaces(
  baseUrl: string,
  token: string,
  maxPages = 10
): Promise<AccountWorkspace[]> {
  const out: AccountWorkspace[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const res = await fetch(`${baseUrl}/v1/account/workspaces${qs}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`account/workspaces failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { workspaces: AccountWorkspace[]; nextCursor: string | null };
    out.push(...body.workspaces);
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  return out;
}
