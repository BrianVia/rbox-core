import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  compareDirectoryRows,
  DIRECTORY_PICKER_PAGE_SIZE,
  DirectoryListingCache,
  directoryPickerPrompt,
  highlightedAnswer,
  projectDirectoryPicker,
  rankDirectoryChildren,
  tabRewrite,
  type DirectoryEntryLike,
  type DirectoryPickerOptions,
  type DirectoryPickerRow,
  type DirectoryReader,
} from "./directory-picker.js";

type EntryKind = "directory" | "file" | "symlink";

function entry(name: string, kind: EntryKind): DirectoryEntryLike {
  return {
    name,
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink",
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function fakeReader(
  directories: Record<string, DirectoryEntryLike[] | Error>,
  symlinks: Record<string, boolean | Error> = {},
): DirectoryReader & { reads: string[]; stats: string[] } {
  const reads: string[] = [];
  const stats: string[] = [];
  return {
    reads,
    stats,
    readdirSync(directory, options) {
      reads.push(directory);
      expect(options).toEqual({ withFileTypes: true });
      const result = directories[directory];
      if (result instanceof Error) throw result;
      if (!result) throw errno("ENOENT");
      return result;
    },
    statSync(target) {
      stats.push(target);
      const result = symlinks[target];
      if (result instanceof Error) throw result;
      if (result === undefined) throw errno("ENOENT");
      return { isDirectory: () => result };
    },
  };
}

function cacheFor(
  directories: Record<string, DirectoryEntryLike[] | Error>,
  symlinks: Record<string, boolean | Error> = {},
): { cache: DirectoryListingCache; reader: ReturnType<typeof fakeReader> } {
  const reader = fakeReader(directories, symlinks);
  return { cache: new DirectoryListingCache(reader), reader };
}

function synthetic(kind: "use-input" | "use-current", answer: string): DirectoryPickerRow {
  return { kind, label: answer, answer, name: answer, matchClass: 0, matchSpan: 0 };
}

describe("directory child comparator", () => {
  test("implements every precedence rung and synthetic tie", () => {
    const children = rankDirectoryChildren(
      ["xpro", "p---r---o", "p-r-o", ".pro", "proposal", "Project"],
      "pro",
      "/work",
    );
    expect(children.map((row) => row.name)).toEqual([
      "Project", // prefix, alphabetical before proposal
      "proposal",
      "xpro", // substring, non-dot before dot
      ".pro",
      "p-r-o", // tighter subsequence span
      "p---r---o",
    ]);

    const all = [children[0]!, synthetic("use-current", "/work"), synthetic("use-input", "/work/pro")]
      .sort(compareDirectoryRows);
    expect(all.map((row) => row.kind)).toEqual(["use-input", "use-current", "child"]);
    expect(compareDirectoryRows(synthetic("use-input", "a"), synthetic("use-input", "a"))).toBe(0);
  });

  test("pins empty, dot-prefixed, case-only, Unicode, and sparse-subsequence ties", () => {
    expect(rankDirectoryChildren(["beta", ".alpha", "Alpha", "alpha"], "", "/x").map((row) => row.name))
      .toEqual(["Alpha", "alpha", "beta", ".alpha"]);
    expect(rankDirectoryChildren(["config", ".config", ".cache"], ".c", "/x").map((row) => row.name))
      .toEqual([".cache", ".config"]);
    expect(rankDirectoryChildren(["a---b", "axb", "ab"], "ab", "/x").map((row) => row.name))
      .toEqual(["ab", "axb", "a---b"]);
    expect(rankDirectoryChildren(["a--b--c", "a---ab-c"], "abc", "/x").map((row) => row.name))
      .toEqual(["a---ab-c", "a--b--c"]);
    expect(rankDirectoryChildren(["é", "e\u0301"], "", "/x").map((row) => row.name))
      .toEqual(["e\u0301", "é"]);
    expect(rankDirectoryChildren(["ALPHA", "alpha"], "AlP", "/x").map((row) => row.name))
      .toEqual(["ALPHA", "alpha"]);
  });

  test("non-dot beats dot only after class and span", () => {
    expect(rankDirectoryChildren([".a", "ba"], "a", "/x").map((row) => row.name)).toEqual(["ba", ".a"]);
    expect(rankDirectoryChildren([".ab", "a---b"], "ab", "/x").map((row) => row.name)).toEqual([".ab", "a---b"]);
    expect(rankDirectoryChildren([".axb", "a---b"], "ab", "/x").map((row) => row.name)).toEqual([".axb", "a---b"]);
  });
});

describe("staged path projection", () => {
  test("owns lexical boundary and filter fields before expansion", () => {
    const { cache } = cacheFor({ "/work": [], "/home/test": [] });
    const base = { message: "path", cwd: "/work", home: "/home/test", cache };
    expect(projectDirectoryPicker("   ", base)).toMatchObject({ raw: "   ", lexical: "", boundary: true, filterTerm: "" });
    expect(projectDirectoryPicker("~", base)).toMatchObject({ lexical: "~", boundary: true, resolved: "/home/test", listDir: "/home/test" });
    expect(projectDirectoryPicker("~/", base)).toMatchObject({ lexical: "~/", boundary: true, filterTerm: "", resolved: "/home/test" });
    expect(projectDirectoryPicker("foo/bar", base)).toMatchObject({ boundary: false, filterTerm: "bar", resolved: "/work/foo/bar", listDir: "/work/foo" });
    expect(projectDirectoryPicker("foo/", base)).toMatchObject({ boundary: true, filterTerm: "", resolved: "/work/foo", listDir: "/work/foo" });
  });

  test("initial listing and bare Enter use the canonical default pipeline", () => {
    const { cache } = cacheFor({ "/outside": [entry("child", "directory")], "/home/test": [], "/work": [] });
    const initial = projectDirectoryPicker("", { message: "path", cwd: "/work", default: "/outside", home: "/home/test", cache });
    expect(initial.listDir).toBe("/outside");
    expect(initial.rows[0]?.label).toBe("use this directory (/outside)");
    expect(highlightedAnswer(initial, 0)).toBe("/outside");

    const tilde = projectDirectoryPicker("", { message: "path", cwd: "/work", default: "~", home: "/home/test", cache });
    expect(tilde.listDir).toBe("/home/test");
    expect(highlightedAnswer(tilde, 0)).toBe("/home/test");

    const none = projectDirectoryPicker("", { message: "path", cwd: "/work", home: "/home/test", cache });
    expect(none.listDir).toBe("/work");
    expect(highlightedAnswer(none, 0)).toBe("/work");
  });

  test("resolution always uses cwd while whitespace lists default and Enter answers cwd", () => {
    const { cache } = cacheFor({ "/outside": [], "/work": [] });
    const projection = projectDirectoryPicker("   ", {
      message: "path", cwd: "/work", default: "/outside", home: "/home/test", cache,
    });
    expect(projection.resolved).toBe("/work");
    expect(projection.listDir).toBe("/outside");
    expect(projection.rows.map((row) => row.label)).toEqual([
      "use \"/work\"",
      "use this directory (/outside)",
    ]);
    expect(highlightedAnswer(projection, 0)).toBe("/work");
  });

  test("unsupported user and unsupported default remain no-answer editor states", () => {
    const { cache } = cacheFor({ "/work": [entry("project", "directory")] });
    for (const raw of ["~user", " ~user"]) {
      const projection = projectDirectoryPicker(raw, { message: "path", cwd: "/work", home: "/home/test", cache });
      expect(projection.resolved).toBeUndefined();
      expect(projection.rows).toEqual([]);
      expect(projection.notice).toContain("~user paths aren't supported");
      expect(highlightedAnswer(projection, 0)).toBeUndefined();
    }
    const badDefault = projectDirectoryPicker("", {
      message: "path", cwd: "/work", default: "~somebody", home: "/home/test", cache,
    });
    expect(badDefault.rows).toEqual([]);
    expect(highlightedAnswer(badDefault, 0)).toBeUndefined();
    const recovered = projectDirectoryPicker("valid/", {
      message: "path", cwd: "/work", default: "~somebody", home: "/home/test", cache,
    });
    expect(recovered).toMatchObject({ resolved: "/work/valid", listDir: "/work/valid" });
    expect(recovered.notice).toContain("does not exist");
    expect(recovered.rows[0]?.answer).toBe("/work/valid");
    const completable = projectDirectoryPicker("pro", {
      message: "path", cwd: "/work", default: "~somebody", home: "/home/test", cache,
    });
    expect(completable.notice).toBeUndefined();
    expect(completable.children.map((row) => row.name)).toEqual(["project"]);
    expect(tabRewrite(completable, "/work")).toBe("project/");
    expect(highlightedAnswer(completable, 0)).toBe("/work/pro");
  });
});

describe("Tab and edit transitions", () => {
  const directories = {
    "/work": [entry("project", "directory"), entry("foo", "directory")],
    "/work/project": [],
    "/work/foo": [entry("bar", "directory")],
    "/": [entry("project", "directory")],
    "/home/test": [entry("Documents", "directory")],
    "/base": [entry("project", "directory")],
    "/outside": [entry("external", "directory")],
  };

  function projection(raw: string, defaultValue = "/work") {
    const { cache } = cacheFor(directories);
    return projectDirectoryPicker(raw, {
      message: "path", cwd: "/work", default: defaultValue, home: "/home/test", cache,
    });
  }

  test("Tab descends and Backspace past slash naturally re-lists the parent", () => {
    const { cache, reader } = cacheFor(directories);
    const opts = { message: "path", cwd: "/work", default: "/work", home: "/home/test", cache };
    const filtered = projectDirectoryPicker("pro", opts);
    const completed = tabRewrite(filtered, "/work");
    expect(completed).toBe("project/");
    expect(highlightedAnswer(filtered, 0)).toBe("/work/pro");
    expect(projectDirectoryPicker(completed!, opts).listDir).toBe("/work/project");
    const afterBackspace = completed!.slice(0, -1);
    expect(projectDirectoryPicker(afterBackspace, opts)).toMatchObject({ listDir: "/work", filterTerm: "project" });
    expect(reader.reads).toEqual(["/work", "/work/project"]);
  });

  test("preserves .., tilde, absolute, and repeated-slash lexical prefixes", () => {
    expect(tabRewrite(projection("../pro"), "/work")).toBe("../project/");
    expect(projection("../")).toMatchObject({ resolved: "/", listDir: "/", boundary: true });
    expect(tabRewrite(projection("~/Do"), "/work")).toBe("~/Documents/");
    expect(tabRewrite(projection("~/"), "/work")).toBe("~/Documents/");
    expect(tabRewrite(projection("~"), "/work")).toBe("~/Documents/");
    expect(tabRewrite(projection("/base/pro"), "/work")).toBe("/base/project/");
    expect(tabRewrite(projection("foo//ba"), "/work")).toBe("foo//bar/");
  });

  test("double Tab descends instead of resolving foo twice", () => {
    const first = tabRewrite(projection("foo"), "/work");
    expect(first).toBe("foo/");
    const second = tabRewrite(projection(first!), "/work");
    expect(second).toBe("foo/bar/");
    expect(second).not.toContain("foo/foo");
  });

  test("semantic-empty rewrites choose relative cwd or absolute default and drop whitespace", () => {
    expect(tabRewrite(projection(""), "/work")).toBe("foo/");
    expect(tabRewrite(projection("   "), "/work")).toBe("foo/");
    expect(tabRewrite(projection("", "/outside"), "/work")).toBe("/outside/external/");
    expect(tabRewrite(projection("   ", "/outside"), "/work")).toBe("/outside/external/");
    expect(tabRewrite(projection("  pro  "), "/work")).toBe("project/");
  });

  test("Tab is a no-op when there is no matching child", () => {
    expect(tabRewrite(projection("zzz"), "/work")).toBeUndefined();
  });
});

describe("rows, symlinks, cache, and errors", () => {
  test("row 1 accepts nonexistent and exact hidden-name literals", () => {
    const { cache } = cacheFor({ "/work": [
      entry(".git", "directory"), entry("node_modules", "directory"), entry(".rbox", "directory"), entry(".visible", "directory"),
    ] });
    const missing = projectDirectoryPicker("does-not-exist", { message: "path", cwd: "/work", cache });
    expect(missing.rows[0]?.label).toBe("use \"/work/does-not-exist\"");
    expect(highlightedAnswer(missing, 0)).toBe("/work/does-not-exist");
    const hidden = projectDirectoryPicker("node_modules", { message: "path", cwd: "/work", cache });
    expect(hidden.rows.map((row) => row.name)).toEqual(["/work/node_modules"]);
    expect(highlightedAnswer(hidden, 0)).toBe("/work/node_modules");
    expect(projectDirectoryPicker(".v", { message: "path", cwd: "/work", cache }).children.map((row) => row.name))
      .toEqual([".visible"]);
  });

  test("follows each symlink once, selects directory links, and omits file/broken links", () => {
    const { cache, reader } = cacheFor({
      "/work": [
        entry("dir-link", "symlink"), entry("file-link", "symlink"), entry("broken", "symlink"), entry(".git", "symlink"), entry("file", "file"),
      ],
      "/work/dir-link": [entry("nested", "directory")],
    }, {
      "/work/dir-link": true,
      "/work/file-link": false,
      "/work/broken": errno("ENOENT"),
      "/work/.git": true,
    });
    const first = projectDirectoryPicker("", { message: "path", cwd: "/work", cache });
    expect(first.children.map((row) => row.name)).toEqual(["dir-link"]);
    expect(highlightedAnswer(first, 1)).toBe("/work/dir-link");
    projectDirectoryPicker("d", { message: "path", cwd: "/work", cache });
    expect(projectDirectoryPicker("dir-link/", { message: "path", cwd: "/work", cache }).children.map((row) => row.name))
      .toEqual(["nested"]);
    expect(reader.stats).toEqual(["/work/dir-link", "/work/file-link", "/work/broken", "/work/.git"]);
  });

  test("memoizes one blocking read per listDir across A to B to A", () => {
    const a = [entry("old", "directory")];
    const reader = fakeReader({ "/a": a, "/b": [entry("bee", "directory")] });
    const cache = new DirectoryListingCache(reader);
    expect(cache.get("/a").children).toEqual(["old"]);
    expect(cache.get("/b").children).toEqual(["bee"]);
    a.push(entry("new", "directory"));
    expect(cache.get("/a").children).toEqual(["old"]);
    expect(reader.reads).toEqual(["/a", "/b"]);
    expect(new DirectoryListingCache(reader).get("/a").children).toEqual(["old", "new"]);
  });

  test("filtering is synchronous and allocation-light after a many-files listing", () => {
    const files = Array.from({ length: 112_000 }, (_, index) => entry(`file-${index}`, "file"));
    files.push(entry("project", "directory"), entry("proposal", "directory"), entry("other", "directory"));
    const { cache, reader } = cacheFor({ "/work": files, "/work/project": [entry("nested", "directory")] });
    for (let index = 0; index < 100; index++) {
      const raw = index % 3 === 0 ? "project/" : index % 2 ? "pro" : "prj";
      const result = projectDirectoryPicker(raw, { message: "path", cwd: "/work", cache });
      expect(result).not.toBeInstanceOf(Promise);
    }
    expect(reader.reads).toEqual(["/work/project", "/work"]);
  });

  test("classifies recoverable errors while preserving row-1 editing and selection", () => {
    for (const [code, reason] of [["EACCES", "permission denied"], ["ENOENT", "does not exist"], ["ENOTDIR", "not a directory"]]) {
      const { cache } = cacheFor({ "/blocked": errno(code), "/work": [entry("project", "directory")] });
      const projection = projectDirectoryPicker("/blocked/value", { message: "path", cwd: "/work", cache });
      expect(projection.notice).toBe(`can't read /blocked: ${reason}`);
      expect(projection.rows[0]?.answer).toBe("/blocked/value");
      expect(highlightedAnswer(projection, 0)).toBe("/blocked/value");
      const recovered = projectDirectoryPicker("pro", { message: "path", cwd: "/work", cache });
      expect(recovered.notice).toBeUndefined();
      expect(tabRewrite(recovered, "/work")).toBe("project/");
    }
  });

  test("does not hide unexpected filesystem failures", () => {
    const { cache } = cacheFor({ "/work": errno("EIO") });
    expect(() => projectDirectoryPicker("", { message: "path", cwd: "/work", cache })).toThrow("EIO");
  });
});

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function runPicker(
  keys: string,
  overrides: Partial<DirectoryPickerOptions> = {},
): Promise<{ answer: string; output: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-picker-"));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, "project"));
  fs.mkdirSync(path.join(root, "proposal"));
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk.toString(); });
  const pending = directoryPickerPrompt({ message: "Which directory?", cwd: root, ...overrides }, { input, output });
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.write(keys);
  const answer = await pending;
  return { answer, output: rendered };
}

describe("real @inquirer/core directory prompt", () => {
  test("literal plus Enter has no loading race and returns the literal", async () => {
    const result = await runPicker("typo\r");
    expect(result.answer).toEndWith("/typo");
    expect(result.output).toContain("Which directory?");
    expect(result.output).toContain("Enter = this directory · type to filter · Tab completes");
    expect(result.output).not.toContain("loading");
  });

  test("Tab completes the best child, ignores highlight, and Enter submits completion", async () => {
    const result = await runPicker("p\x1b[B\x1b[B\t\r");
    expect(result.answer).toEndWith("/project");
  });

  test("initial ArrowDown then Enter selects a child rather than the default", async () => {
    const result = await runPicker("\x1b[B\r");
    expect(result.answer).toEndWith("/project");
    expect(path.dirname(result.answer)).not.toBe(result.answer);
  });

  test("unsupported expansion keeps Enter inert and editing live", async () => {
    const result = await runPicker("~user\rrelative\r", { home: "/home/test" });
    expect(result.answer).toEndWith("/relative");
    expect(result.output).toContain("~user paths aren't supported");
  });

  test("an ordinary edit resets the highlight to the pinned use-input row", async () => {
    const result = await runPicker("p\x1b[Bx\r");
    expect(result.answer).toEndWith("/px");
  });

  test("caps rows near twelve and renders a nonselectable overflow notice", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-picker-many-"));
    temporaryDirectories.push(root);
    for (let index = 0; index < 20; index++) fs.mkdirSync(path.join(root, `dir-${String(index).padStart(2, "0")}`));
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => { rendered += chunk.toString(); });
    const pending = directoryPickerPrompt({ message: "path", cwd: root }, { input, output });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(DIRECTORY_PICKER_PAGE_SIZE).toBe(12);
    expect(rendered).toContain("+9 more");
    input.write("\x1b[B".repeat(DIRECTORY_PICKER_PAGE_SIZE));
    input.write("\r");
    expect(await pending).toBe(root);
  });
});
