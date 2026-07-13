/**
 * The "track an existing workspace" picker (Feature B) — PURE logic plus the tiny
 * display helpers `rbox status` shares, and one impure entry point. Everything the
 * picker's behavior turns on (sorting, labelling, building/filtering the inquirer
 * choices, choosing select-vs-search) is pure and TTY-free, so it's unit-tested
 * without a server or a terminal; only `promptWorkspacePick` (the inquirer widget)
 * and `fetchAccountWorkspaces` (the thin HTTP helper) do I/O.
 *
 * It replaces the old "paste a workspace id copied from another machine" prompt:
 * the CLI already knows the account's workspaces, so it lets the user pick one by
 * NAME (an arrow-key select, or a type-to-filter search for long lists) — while
 * KEEPING a manual-id fallback for cross-account / edge cases and the scripted
 * `--workspace <id>` path.
 */
import { translateRemoteError } from "./remote/errors.js";

/** One row of `GET /v1/account/workspaces` (E2EE: the server holds no path — `name`
 *  is the opt-in dashboard label, null unless the creating host set one). */
export interface AccountWorkspace {
  workspaceId: string;
  projectId: string;
  name: string | null;
  createdAt: number; // epoch ms
  /** Last-activity signal: MAX(commit.createdAt), epoch ms; null/absent = never
   *  synced. Additive field — older servers omit it, so it degrades to "never
   *  synced" rather than a crash. */
  lastCommitAt?: number | null;
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

// ── inquirer picker: pure choice-building + the one impure entry point ─────────
// The inquirer wrapper is imported LAZILY inside `promptWorkspacePick` (not at
// module top) so `rbox status` — which pulls only the pure display helpers from
// here — never loads inquirer's module graph on that hot path.

/** Above this many workspaces the picker switches from an arrow-key `select` to a
 *  type-to-filter `search` (a long static list is worse than a search box). */
export const SELECT_MAX = 8;

/** A `select` for small lists, a filterable `search` once past SELECT_MAX. */
export function pickerMode(count: number): "select" | "search" {
  return count > SELECT_MAX ? "search" : "select";
}

/** An inquirer choice: `value` is the raw workspaceId (what the picker returns),
 *  `name` is the display line (label · age · short id). */
export interface WorkspaceChoice {
  name: string;
  value: string;
}

/** Sentinel `value` for the "enter an id manually" escape hatch. The leading NUL
 *  escape keeps it from ever colliding with a real `ws_…` id (and stays out of
 *  every printable namespace — as a \0 ESCAPE, never a raw byte: a literal NUL
 *  makes git treat this source file as binary). */
const MANUAL = "\0manual";
const MANUAL_CHOICE: WorkspaceChoice = { name: "Enter an id manually…", value: MANUAL };

/** Build display choices from an ALREADY-SORTED list. `value` = workspaceId so the
 *  picker's return is directly usable; `name` = `label · created <age> · last synced
 *  <age> · short-id` where the label is the opt-in name (else the short id). BOTH
 *  timestamps are labelled: an unlabelled "22h ago" is ambiguous (created vs. active).
 *  A workspace with no commits renders `never synced`. Pure — no sentinel appended. */
export function buildWorkspaceChoices(sorted: AccountWorkspace[], nowMs: number): WorkspaceChoice[] {
  return sorted.map((ws) => {
    const created = `created ${relativeAge(ws.createdAt, nowMs)}`;
    const synced = ws.lastCommitAt ? `last synced ${relativeAge(ws.lastCommitAt, nowMs)}` : "never synced";
    return {
      name: `${workspacePickLabel(ws)} · ${created} · ${synced} · ${shortWorkspaceId(ws.workspaceId)}`,
      value: ws.workspaceId,
    };
  });
}

/** Case-insensitive substring filter over a choice's display `name`. An empty/blank
 *  term returns the full list (the `search` box's initial state). */
export function filterWorkspaceChoices(choices: WorkspaceChoice[], term: string | undefined): WorkspaceChoice[] {
  const t = (term ?? "").trim().toLowerCase();
  if (!t) return choices;
  return choices.filter((c) => c.name.toLowerCase().includes(t));
}

/** A picked workspace: its id, plus the server `name` when the pick came from the
 *  list (so callers can cache the label locally). Manual-id entry has no name. */
export interface WorkspacePick {
  workspaceId: string;
  name?: string;
}

/**
 * Pick a workspace to track from the account's synced list, by NAME — the
 * "paste an id" replacement. The ONLY picker fn that touches inquirer.
 *
 * Degrades to a manual `input` prompt (preserving today's behavior) when: there's
 * no token, the fetch throws (offline / non-2xx), or the account has no workspaces.
 * Otherwise it lists the workspaces newest-first (a `select` up to SELECT_MAX, a
 * type-to-filter `search` beyond it) with a trailing "enter an id manually…"
 * escape hatch. Returns the chosen id (carrying the server `name` when picked from
 * the list, so callers can cache it locally for `rbox status`), or `undefined` if
 * the user backed out of manual entry (blank).
 *
 * Callers MUST gate on `isInteractive()` — inquirer requires a TTY.
 */
export async function promptWorkspacePick(opts: {
  baseUrl: string;
  token?: string;
  nowMs?: number;
}): Promise<WorkspacePick | undefined> {
  const nowMs = opts.nowMs ?? Date.now();
  const { promptInput, promptSelect, promptSearch } = await import("./prompt.js");

  let sorted: AccountWorkspace[] = [];
  if (opts.token) {
    try {
      sorted = sortWorkspacesForPick(await fetchAccountWorkspaces(opts.baseUrl, opts.token));
    } catch {
      // offline / non-2xx → fall through to manual entry (graceful degradation).
    }
  }
  if (sorted.length === 0) return manualEntry(promptInput);

  const choices = buildWorkspaceChoices(sorted, nowMs);
  let chosen: string;
  if (pickerMode(sorted.length) === "select") {
    chosen = await promptSelect<string>({
      message: "Pick an existing workspace to sync",
      choices: [...choices, MANUAL_CHOICE],
    });
  } else {
    chosen = await promptSearch<string>({
      message: "Search existing workspaces to sync (type to filter)",
      source: (term) => [...filterWorkspaceChoices(choices, term), MANUAL_CHOICE],
    });
  }
  if (chosen === MANUAL) return manualEntry(promptInput);
  // Carry the picked workspace's server name so callers cache the label locally.
  return { workspaceId: chosen, name: sorted.find((w) => w.workspaceId === chosen)?.name ?? undefined };
}

/** The kept manual-id fallback: cross-account / already-known ids. Blank → undefined.
 *  No name is known this way (status falls back to the id). Takes `promptInput` from
 *  the lazily-imported wrapper so this module stays inquirer-free until
 *  `promptWorkspacePick` actually runs. */
async function manualEntry(
  promptInput: (typeof import("./prompt.js"))["promptInput"]
): Promise<WorkspacePick | undefined> {
  const id = (await promptInput({ message: "Workspace id to sync" })).trim();
  return id ? { workspaceId: id } : undefined;
}

/**
 * Fetch ALL of the caller's workspaces, following the keyset cursor. Bounded by
 * `maxPages` so a pathological account can't spin forever — the picker only needs
 * enough to choose from, not an exhaustive dump. Throws on a non-2xx so `setup`
 * can degrade to manual entry. `fetchFn` is injectable so the paging/error logic
 * is unit-tested without a server.
 */
export async function fetchAccountWorkspaces(
  baseUrl: string,
  token: string,
  maxPages = 10,
  fetchFn: typeof fetch = fetch
): Promise<AccountWorkspace[]> {
  const out: AccountWorkspace[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const res = await fetchFn(`${baseUrl}/v1/account/workspaces${qs}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(translateRemoteError(res.status, "account/workspaces failed", await res.text(), "workspace list not found — check you're signed in to the right account"));
    const body = (await res.json()) as { workspaces: AccountWorkspace[]; nextCursor: string | null };
    out.push(...body.workspaces);
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  return out;
}
