import { test, expect } from "bun:test";
import {
  shortWorkspaceId,
  relativeAge,
  workspacePickLabel,
  sortWorkspacesForPick,
  renderWorkspacePickList,
  resolveWorkspacePick,
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

// ── rendering ─────────────────────────────────────────────────────────────────

test("renderWorkspacePickList numbers rows 1..n, uses the label, shows a created-age", () => {
  const sorted = sortWorkspacesForPick([
    ws({ name: "~/conductor/workspaces", createdAt: NOW - 21 * 3_600_000 }),
    ws({ name: "~/projects/savvy-core", createdAt: NOW - 12 * 3_600_000 }),
  ]);
  const lines = renderWorkspacePickList(sorted, NOW);
  expect(lines).toHaveLength(2);
  // newest first → savvy-core is #1
  expect(lines[0]).toContain("1");
  expect(lines[0]).toContain("~/projects/savvy-core");
  expect(lines[0]).toContain("created 12h ago");
  expect(lines[1]).toContain("2");
  expect(lines[1]).toContain("~/conductor/workspaces");
  expect(lines[1]).toContain("created 21h ago");
});

test("renderWorkspacePickList falls back to the short id for an unnamed workspace", () => {
  const lines = renderWorkspacePickList([ws({ name: null, workspaceId: "ws_deadbeef1234" })], NOW);
  expect(lines[0]).toContain("ws_deadbeef");
});

test("renderWorkspacePickList is empty for an empty list (caller handles the empty case)", () => {
  expect(renderWorkspacePickList([], NOW)).toEqual([]);
});

// ── resolving a typed pick ────────────────────────────────────────────────────

test("resolveWorkspacePick maps an in-range number to that workspace id + name", () => {
  const sorted = sortWorkspacesForPick([
    ws({ workspaceId: "ws_new", name: "newest", createdAt: 300 }),
    ws({ workspaceId: "ws_old", name: null, createdAt: 100 }),
  ]);
  expect(resolveWorkspacePick(sorted, "1")).toEqual({ kind: "pick", workspaceId: "ws_new", name: "newest" });
  expect(resolveWorkspacePick(sorted, " 2 ")).toEqual({ kind: "pick", workspaceId: "ws_old", name: null });
});

test("resolveWorkspacePick recognizes the manual-entry escape hatch", () => {
  const sorted = [ws()];
  for (const s of ["m", "manual", "PASTE", " m "]) {
    expect(resolveWorkspacePick(sorted, s)).toEqual({ kind: "manual" });
  }
});

test("resolveWorkspacePick returns null for out-of-range / non-numeric answers (re-prompt)", () => {
  const sorted = [ws(), ws()];
  expect(resolveWorkspacePick(sorted, "0")).toBeNull();
  expect(resolveWorkspacePick(sorted, "3")).toBeNull();
  expect(resolveWorkspacePick(sorted, "")).toBeNull();
  expect(resolveWorkspacePick(sorted, "abc")).toBeNull();
  expect(resolveWorkspacePick(sorted, "1x")).toBeNull();
});
