import { test, expect } from "bun:test";
import {
  shortWorkspaceId,
  relativeAge,
  workspacePickLabel,
  sortWorkspacesForPick,
  pickerMode,
  buildWorkspaceChoices,
  filterWorkspaceChoices,
  fetchAccountWorkspaces,
  SELECT_MAX,
  type AccountWorkspace,
} from "./workspace-picker.js";

// The picker's whole decision surface — sorting, labelling, rendering, resolving a
// typed answer to an id — is pure. We test that (the readline shell is a thin wrapper).

const ws = (over: Partial<AccountWorkspace> = {}): AccountWorkspace => ({
  workspaceId: "ws_abcdef0123456789",
  projectId: "root",
  name: null,
  createdAt: 1_000_000,
  ...over,
});

const NOW = 10_000_000_000; // fixed clock so age formatting is deterministic

// ── labelling + name fallback ──────────────────────────────────────────────

test("label prefers the opt-in name; falls back to a short id when name is null", () => {
  expect(workspacePickLabel(ws({ name: "~/conductor/workspaces" }))).toBe("~/conductor/workspaces");
  expect(workspacePickLabel(ws({ name: null, workspaceId: "ws_ab12cd34ef56" }))).toBe("ws_ab12cd34");
});

test("shortWorkspaceId keeps the ws_ prefix + 8 hex; passes short/odd ids through", () => {
  expect(shortWorkspaceId("ws_ab12cd34ff99")).toBe("ws_ab12cd34");
  expect(shortWorkspaceId("ws_short")).toBe("ws_short"); // body ≤ 8 → unchanged
  expect(shortWorkspaceId("nolowerprefix")).toBe("nolowerpref…"); // no `_` → bounded
});

// ── relative age ────────────────────────────────────────────────────────────

test("relativeAge renders compact human buckets", () => {
  expect(relativeAge(NOW, NOW)).toBe("just now");
  expect(relativeAge(NOW - 30_000, NOW)).toBe("just now"); // < 1 min
  expect(relativeAge(NOW - 5 * 60_000, NOW)).toBe("5m ago");
  expect(relativeAge(NOW - 21 * 3_600_000, NOW)).toBe("21h ago");
  expect(relativeAge(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
  expect(relativeAge(NOW - 90 * 86_400_000, NOW)).toBe("3mo ago");
});

// ── sorting (newest first) ────────────────────────────────────────────────────

test("sortWorkspacesForPick orders by createdAt desc without mutating the input", () => {
  const a = ws({ workspaceId: "ws_a", createdAt: 100 });
  const b = ws({ workspaceId: "ws_b", createdAt: 300 });
  const c = ws({ workspaceId: "ws_c", createdAt: 200 });
  const input = [a, b, c];
  const sorted = sortWorkspacesForPick(input);
  expect(sorted.map((w) => w.workspaceId)).toEqual(["ws_b", "ws_c", "ws_a"]);
  expect(input.map((w) => w.workspaceId)).toEqual(["ws_a", "ws_b", "ws_c"]); // unmutated
});

// ── inquirer picker: pure choice-building + mode selection ─────────────────────

test("pickerMode: a select up to SELECT_MAX, a search once past it", () => {
  expect(pickerMode(1)).toBe("select");
  expect(pickerMode(SELECT_MAX)).toBe("select"); // 8 → still a select
  expect(pickerMode(SELECT_MAX + 1)).toBe("search"); // 9 → search box
});

test("buildWorkspaceChoices: value is the raw workspaceId; name labels created + last synced", () => {
  const sorted = sortWorkspacesForPick([
    ws({ workspaceId: "ws_deadbeef1234", name: "savvy-core", createdAt: NOW - 12 * 3_600_000, lastCommitAt: NOW - 2 * 60_000 }),
    ws({ workspaceId: "ws_cafef00d5678", name: null, createdAt: NOW - 21 * 3_600_000, lastCommitAt: NOW - 3 * 86_400_000 }),
  ]);
  const choices = buildWorkspaceChoices(sorted, NOW);
  // value round-trips exactly to the id the picker returns.
  expect(choices.map((c) => c.value)).toEqual(["ws_deadbeef1234", "ws_cafef00d5678"]);
  // named workspace: label = name; both timestamps are labelled (the ambiguity fix).
  expect(choices[0]!.name).toBe("savvy-core · created 12h ago · last synced 2m ago · ws_deadbeef");
  // unnamed workspace: label falls back to the short id.
  expect(choices[1]!.name).toBe("ws_cafef00d · created 21h ago · last synced 3d ago · ws_cafef00d");
});

test("buildWorkspaceChoices: a never-synced workspace degrades to 'never synced', still labelled", () => {
  // lastCommitAt null (no commits yet) AND absent (older server omits the field) both
  // render the same graceful, labelled fallback — never a bare/ambiguous age.
  const nullSynced = buildWorkspaceChoices([ws({ workspaceId: "ws_fresh0000000", name: "brand-new", createdAt: NOW - 5 * 60_000, lastCommitAt: null })], NOW);
  expect(nullSynced[0]!.name).toBe("brand-new · created 5m ago · never synced · ws_fresh000");
  const absentSynced = buildWorkspaceChoices([ws({ workspaceId: "ws_fresh0000000", name: "brand-new", createdAt: NOW - 5 * 60_000 })], NOW);
  expect(absentSynced[0]!.name).toBe("brand-new · created 5m ago · never synced · ws_fresh000");
});

test("filterWorkspaceChoices: case-insensitive substring; blank term keeps all", () => {
  const choices = buildWorkspaceChoices(
    sortWorkspacesForPick([
      ws({ workspaceId: "ws_a", name: "savvy-core", createdAt: 300 }),
      ws({ workspaceId: "ws_b", name: "conductor", createdAt: 200 }),
      ws({ workspaceId: "ws_c", name: "SAVVY-web", createdAt: 100 }),
    ]),
    NOW
  );
  expect(filterWorkspaceChoices(choices, "savvy").map((c) => c.value)).toEqual(["ws_a", "ws_c"]);
  expect(filterWorkspaceChoices(choices, "  ").map((c) => c.value)).toEqual(["ws_a", "ws_b", "ws_c"]);
  expect(filterWorkspaceChoices(choices, undefined)).toHaveLength(3);
  expect(filterWorkspaceChoices(choices, "nomatch")).toHaveLength(0);
});

// ── fetch paging (injected fetch — no server) ──────────────────────────────────

/** A fetch stub that replays a scripted sequence of pages by cursor. */
function pagedFetch(pages: Array<{ workspaces: AccountWorkspace[]; nextCursor: string | null }>): {
  fetchFn: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  const fetchFn = (async (url: string) => {
    calls.push(url);
    const body = pages[i++]!;
    return { ok: true, status: 200, json: async () => body, text: async () => "" } as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

test("fetchAccountWorkspaces follows nextCursor across pages, stops when it's null", async () => {
  const { fetchFn, calls } = pagedFetch([
    { workspaces: [ws({ workspaceId: "ws_1" })], nextCursor: "c1" },
    { workspaces: [ws({ workspaceId: "ws_2" })], nextCursor: "c2" },
    { workspaces: [ws({ workspaceId: "ws_3" })], nextCursor: null },
  ]);
  const all = await fetchAccountWorkspaces("https://api", "tok", 10, fetchFn);
  expect(all.map((w) => w.workspaceId)).toEqual(["ws_1", "ws_2", "ws_3"]);
  expect(calls).toHaveLength(3);
  expect(calls[1]).toContain("cursor=c1");
  expect(calls[2]).toContain("cursor=c2");
});

test("fetchAccountWorkspaces is bounded by maxPages (won't spin on an endless cursor)", async () => {
  const { fetchFn, calls } = pagedFetch([
    { workspaces: [ws({ workspaceId: "ws_1" })], nextCursor: "c1" },
    { workspaces: [ws({ workspaceId: "ws_2" })], nextCursor: "c2" },
    { workspaces: [ws({ workspaceId: "ws_3" })], nextCursor: "c3" }, // still more, but capped
  ]);
  const all = await fetchAccountWorkspaces("https://api", "tok", 2, fetchFn);
  expect(all.map((w) => w.workspaceId)).toEqual(["ws_1", "ws_2"]);
  expect(calls).toHaveLength(2);
});

test("fetchAccountWorkspaces throws on a non-2xx (callers degrade to manual entry)", async () => {
  const fetchFn = (async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" }) as Response) as unknown as typeof fetch;
  await expect(fetchAccountWorkspaces("https://api", "tok", 10, fetchFn)).rejects.toThrow(/500/);
});
