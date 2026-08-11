import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureFolderAuthority } from "./folder-authority.js";
import { promptMissing } from "./init-cmd.js";
import { track } from "./track-cmd.js";
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
  promptWorkspacePick,
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

// ── TUI picker: pure choice-building + mode selection ──────────────────────────

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
  await expect(fetchAccountWorkspaces("https://api", "tok", 10, fetchFn)).rejects.toThrow(/servers are having trouble/);
});

test("setup picker: empty account returns empty-account with message and no manual prompt", async () => {
  const writes: string[] = [];
  let prompts = 0;
  const result = await promptWorkspacePick({
    baseUrl: "https://api.test",
    token: "tok",
    mode: "setup",
    deps: {
      fetchList: async () => ({ kind: "empty" }),
      promptInput: (async () => { prompts++; return "unexpected"; }) as never,
      writeStderr: (text) => void writes.push(text),
    },
  });
  expect(result).toEqual({ kind: "empty-account" });
  expect(prompts).toBe(0);
  expect(writes.join("")).toContain("no synced folders on this account yet");
});

test("setup picker: fetch failure warns, retains entered id, and blank-blank goes back", async () => {
  const run = async (answers: string[]) => {
    const messages: string[] = [];
    const writes: string[] = [];
    const result = await promptWorkspacePick({
      baseUrl: "https://api.test",
      token: "tok",
      mode: "setup",
      deps: {
        fetchList: async () => ({ kind: "failed" }),
        promptInput: (async (cfg: { message: string }) => { messages.push(cfg.message); return answers.shift()!; }) as never,
        writeStderr: (text) => void writes.push(text),
      },
    });
    return { result, messages, writes };
  };
  const entered = await run(["", "ws_manual"]);
  expect(entered.result).toEqual({ kind: "picked", pick: { workspaceId: "ws_manual" } });
  expect(entered.messages).toEqual([
    "Workspace id to sync (find it with `rbox list` on an enrolled machine)",
    "Enter a workspace id, or leave blank again to go back",
  ]);
  expect(entered.writes.join("")).toContain("can't list synced folders right now");
  expect((await run(["", ""])).result).toEqual({ kind: "back" });
});

test("setup picker: listed manual escape uses the same two-blank navigation", async () => {
  const answers = ["", "ws_after_blank"];
  const result = await promptWorkspacePick({
    baseUrl: "https://api.test",
    token: "tok",
    mode: "setup",
    deps: {
      fetchList: async () => ({ kind: "listed", rows: [ws({ workspaceId: "ws_listed" })] }),
      promptSelect: (async () => "\0manual") as never,
      promptInput: (async () => answers.shift()!) as never,
    },
  });
  expect(result).toEqual({ kind: "picked", pick: { workspaceId: "ws_after_blank" } });
});

test("legacy picker bit-identity matrix drives both init and track callers", async () => {
  const previousRboxHome = process.env.RBOX_HOME;
  const catalogHome = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-track-picker-home-"));
  process.env.RBOX_HOME = catalogHome;
  await ensureFolderAuthority();
  const cases = [
    { name: "no-token", token: undefined, outcome: undefined },
    { name: "fetch-failure", token: "tok", outcome: { kind: "failed" } as const },
    { name: "successful-empty", token: "tok", outcome: { kind: "empty" } as const },
    { name: "nonempty-manual-escape", token: "tok", outcome: { kind: "listed", rows: [ws({ workspaceId: "ws_listed" })] } as const, manual: true },
  ];

  try {
    for (const c of cases) {
      let initPrompts = 0;
      const initWrites: string[] = [];
      const initPicker = ((opts: { baseUrl: string; token?: string; mode: "legacy" }) => promptWorkspacePick({
        ...opts,
        deps: {
          ...(c.outcome ? { fetchList: async () => c.outcome! } : {}),
          ...(c.manual ? { promptSelect: (async () => "\0manual") as never } : {}),
          promptInput: (async () => { initPrompts++; return ""; }) as never,
          writeStderr: (text) => void initWrites.push(text),
        },
      })) as never;
      const gathered = await promptMissing(
        { project: "root", root: "/tmp/init-root", name: "-", "respect-gitignore": "true" },
        "/tmp",
        {
          creds: c.token ? { token: c.token, remoteUrl: "https://api.test", deviceId: "dev", accountId: "acct" } : undefined,
          defaultRemote: "https://api.test",
          promptSelect: (async () => "join") as never,
          promptWorkspacePick: initPicker,
        }
      );
      expect(gathered.workspace, `init:${c.name}`).toBeUndefined();
      expect(initPrompts, `init:${c.name}`).toBe(1);
      expect(initWrites.join(""), `init:${c.name}`).not.toContain("can't list");

      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-track-picker-"));
      let trackPrompts = 0;
      let creates = 0;
      const trackWrites: string[] = [];
      const trackPicker = ((opts: { baseUrl: string; token?: string; mode: "legacy" }) => promptWorkspacePick({
        ...opts,
        deps: {
          ...(c.outcome ? { fetchList: async () => c.outcome! } : {}),
          ...(c.manual ? { promptSelect: (async () => "\0manual") as never } : {}),
          promptInput: (async () => { trackPrompts++; return ""; }) as never,
          writeStderr: (text) => void trackWrites.push(text),
        },
      })) as never;
      try {
        const result = await track(root, {}, "https://api.test", {
          loadCredentials: (async () => ({
            state: "valid" as const,
            source: "disk" as const,
            credentials: { v: 1 as const, token: c.token, remoteUrl: "https://api.test", deviceId: "dev", accountId: "acct" },
            legacy: false,
            extensions: {},
          })) as never,
          isInteractive: () => true,
          promptSelect: (async () => "existing") as never,
          promptWorkspacePick: trackPicker,
          createRemoteWorkspace: async () => { creates++; return "ws_created"; },
        });
        expect(result.cfg.remoteWorkspaceId, `track:${c.name}`).toBe("ws_created");
        expect(creates, `track:${c.name}`).toBe(1);
        expect(trackPrompts, `track:${c.name}`).toBe(1);
        expect(trackWrites.join(""), `track:${c.name}`).not.toContain("can't list");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (previousRboxHome === undefined) delete process.env.RBOX_HOME;
    else process.env.RBOX_HOME = previousRboxHome;
    await fs.rm(catalogHome, { recursive: true, force: true });
  }
});
