import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_FOLDER_POLICY,
  FOLDER_CATALOG_MAX_BYTES,
  FOLDER_TRASH_MAX_BYTES,
  FOLDER_TRASH_MAX_DAYS,
  collapseFolderPath,
  expandFolderPath,
  inspectFolderCatalog,
  parseFolderCatalog,
  readFolderCatalog,
  resolveFolderPolicy,
  serializeFolderCatalog,
  snapshotPreCatalogPolicy,
  type FolderCatalog,
} from "./folder-config.js";
import { folderCatalogLockPath, folderCatalogPath } from "./rbox-paths.js";
import type { WorkspaceConfig } from "./workspace-config.js";

const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;
const roots: string[] = [];

async function isolate(): Promise<{ base: string; home: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-folder-config-"));
  const home = path.join(base, "user");
  roots.push(base);
  process.env.HOME = home;
  process.env.RBOX_HOME = home;
  await fs.mkdir(home, { recursive: true });
  return { base, home };
}

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = originalRboxHome;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function catalog(over: Partial<FolderCatalog> = {}): FolderCatalog {
  return {
    schemaVersion: 1,
    globalOptions: {},
    folders: [{ name: "Development", path: "~/Development" }],
    ...over,
  };
}

function binding(over: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    remoteWorkspaceId: "ws_1",
    projectId: "root",
    deviceId: "dev_1",
    rootPath: "/root",
    remoteUrl: "https://api.test",
    token: "",
    ...over,
  };
}

describe("closed bounded folder catalog codec", () => {
  test("test preload isolates catalog and lock unless RBOX_HOME is explicit", async () => {
    const { base, home } = await isolate();
    delete process.env.RBOX_HOME;
    const isolated = process.env.RBOX_TEST_FOLDER_CATALOG_DIR;
    expect(isolated).toBeTruthy();
    expect(folderCatalogPath()).toBe(path.join(isolated!, "config.json"));
    expect(folderCatalogLockPath()).toBe(path.join(isolated!, "config.lock"));
    expect(folderCatalogPath().startsWith(`${home}${path.sep}`)).toBe(false);

    const explicit = path.join(base, "explicit-rbox-home");
    process.env.RBOX_HOME = explicit;
    expect(folderCatalogPath()).toBe(path.join(explicit, ".rbox", "config.json"));
    expect(folderCatalogLockPath()).toBe(path.join(explicit, ".rbox", "config.lock"));
  });

  test("preserves valid spelling and resolves nested options fieldwise", async () => {
    const { home } = await isolate();
    const value = catalog({
      globalOptions: { syncGit: false, git: { incremental: false }, trash: { days: 20, maxBytes: 100 } },
      folders: [{
        name: "Development",
        path: "~/Development/../Development",
        options: { syncGit: true, respectGitignore: true, noDrift: true, trash: { days: 0 } },
      }],
    });
    const parsed = parseFolderCatalog(serializeFolderCatalog(value, home), home);
    expect(parsed).toEqual(value);
    expect(expandFolderPath(parsed.folders[0]!.path, home)).toBe(path.join(home, "Development"));
    expect(resolveFolderPolicy(parsed.globalOptions, parsed.folders[0]!.options)).toEqual({
      syncGit: true,
      git: { incremental: false },
      respectGitignore: true,
      noDrift: true,
      trash: { days: 0, maxBytes: 100 },
    });
    expect(resolveFolderPolicy({}, {})).toEqual(DEFAULT_FOLDER_POLICY);
  });

  test("rejects unknown, null, malformed, duplicate, and out-of-bounds values", async () => {
    const { home } = await isolate();
    const invalid: unknown[] = [
      { ...catalog(), extra: true },
      { ...catalog(), globalOptions: { pullOnly: true } },
      { ...catalog(), globalOptions: { trash: null } },
      catalog({ globalOptions: { trash: { days: 1.5 } } }),
      catalog({ folders: [{ name: " e\u0301", path: "~/Development" }] }),
      catalog({ folders: [{ name: "A", path: "~/Development" }, { name: "A", path: "~/Other" }] }),
      catalog({ folders: [{ name: "A", path: "~/Development" }, { name: "B", path: `${home}/Development/../Development` }] }),
    ];
    for (const value of invalid) expect(() => parseFolderCatalog(JSON.stringify(value), home)).toThrow();
    expect(() => parseFolderCatalog(" ".repeat(FOLDER_CATALOG_MAX_BYTES + 1), home)).toThrow(/exceeds/);
  });

  test("rejects invalid numeric fields without truncating or clamping", async () => {
    const { home } = await isolate();
    for (const days of [-1, 1.5, 366, Number.MAX_SAFE_INTEGER]) {
      expect(() => parseFolderCatalog(JSON.stringify(catalog({ globalOptions: { trash: { days } } })), home)).toThrow(/days/);
    }
    for (const maxBytes of [-1, 1.5, 1099511627777]) {
      expect(() => parseFolderCatalog(JSON.stringify(catalog({ globalOptions: { trash: { maxBytes } } })), home)).toThrow(/maxBytes/);
    }
  });

  test("enforces scalar, NFC, whitespace, path, folder-count, and byte bounds", async () => {
    const { home } = await isolate();
    const badNames = ["", " Development", "Development ", "e\u0301", "x".repeat(129), "\ud800"];
    for (const name of badNames) {
      expect(() => parseFolderCatalog(JSON.stringify(catalog({ folders: [{ name, path: "~/Development" }] })), home)).toThrow();
    }
    for (const folderPath of ["Development", "~someone/Development", "~/bad\0path", `/${"é".repeat(2048)}`]) {
      expect(() => parseFolderCatalog(JSON.stringify(catalog({ folders: [{ name: "Development", path: folderPath }] })), home)).toThrow();
    }
    const many = Array.from({ length: 1025 }, (_, index) => ({ name: `f${index}`, path: `/f${index}` }));
    expect(() => parseFolderCatalog(JSON.stringify(catalog({ folders: many })), home)).toThrow(/1024/);
    expect(() => parseFolderCatalog(" ".repeat(FOLDER_CATALOG_MAX_BYTES + 1), home)).toThrow(/exceeds/);
  });

  test("rejects exact duplicates while accepting nested and case-distinct roots", async () => {
    const { home } = await isolate();
    expect(() => parseFolderCatalog(JSON.stringify(catalog({ folders: [
      { name: "Development", path: "~/Development" },
      { name: "Development", path: "~/Other" },
    ] })), home)).toThrow(/duplicates the exact local name/);
    expect(() => parseFolderCatalog(JSON.stringify(catalog({ folders: [
      { name: "Development", path: "~/Development" },
      { name: "Alias", path: `${home}/Development/../Development` },
    ] })), home)).toThrow(/duplicates normalized path/);
    expect(parseFolderCatalog(JSON.stringify(catalog({ folders: [
      { name: "Development", path: "~/Development" },
      { name: "Nested", path: "~/Development/Nested" },
      { name: "development", path: "~/Other" },
    ] })), home).folders).toHaveLength(3);
  });

  test("rejects missing required fields and future schemas", async () => {
    const { home } = await isolate();
    expect(() => parseFolderCatalog(JSON.stringify({ schemaVersion: 1, folders: [] }), home)).toThrow(/globalOptions is required/);
    expect(() => parseFolderCatalog(JSON.stringify({ schemaVersion: 1, globalOptions: {} }), home)).toThrow(/folders is required/);
    expect(() => parseFolderCatalog(JSON.stringify({ schemaVersion: 2, globalOptions: {}, folders: [] }), home)).toThrow(/newer/);
  });

  test("expands and collapses only the home boundary", async () => {
    const { base, home } = await isolate();
    expect(expandFolderPath("~", home)).toBe(home);
    expect(collapseFolderPath(home, home)).toBe("~");
    expect(collapseFolderPath(path.join(home, "Code"), home)).toBe("~/Code");
    expect(collapseFolderPath(path.join(base, "user-copy"), home)).toBe(path.join(base, "user-copy"));
    expect(() => expandFolderPath("~someone/Code", home)).toThrow(/~user/);
  });
});

describe("pre-catalog policy snapshot", () => {
  test("materializes every compatibility default and preserves false and zero", () => {
    expect(snapshotPreCatalogPolicy(binding())).toEqual({
      syncGit: false,
      git: { incremental: true },
      respectGitignore: false,
      noDrift: false,
      trash: { days: 30, maxBytes: 2147483648 },
    });
    expect(snapshotPreCatalogPolicy(binding({
      syncGit: true,
      git: { incremental: false },
      respectGitignore: true,
      noDrift: true,
      trash: { days: 0, maxBytes: 0 },
    }))).toMatchObject({
      syncGit: true,
      git: { incremental: false },
      respectGitignore: true,
      noDrift: true,
      trash: { days: 0, maxBytes: 0 },
    });
  });

  test("trash normalization clamps exactly to codec bounds and remains parseable", async () => {
    const { home } = await isolate();
    const options = snapshotPreCatalogPolicy(binding({
      trash: { days: Number.MAX_VALUE, maxBytes: Number.MAX_VALUE },
    }));
    expect(options.trash).toEqual({ days: FOLDER_TRASH_MAX_DAYS, maxBytes: FOLDER_TRASH_MAX_BYTES });
    expect(() => serializeFolderCatalog(catalog({ folders: [{ name: "A", path: home, options }] }), home)).not.toThrow();
  });
});

describe("single-file authority state", () => {
  test("absent, valid hand-authored, invalid, and unreadable bytes have complete states", async () => {
    await isolate();
    const absent = await inspectFolderCatalog();
    expect(absent.kind).toBe("absent");
    const bytes = `${JSON.stringify(catalog())}  \n`;
    await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
    await fs.writeFile(folderCatalogPath(), bytes);
    const authoritative = await inspectFolderCatalog();
    expect(authoritative.kind).toBe("authoritative");
    expect((await readFolderCatalog()).catalog).toEqual(catalog());

    await fs.writeFile(folderCatalogPath(), "{");
    const damaged = await inspectFolderCatalog();
    expect(damaged).toMatchObject({ kind: "damaged" });
    expect(damaged.revision).not.toBe(absent.revision);
    await expect(readFolderCatalog()).rejects.toThrow(/damaged/);

    await fs.writeFile(folderCatalogPath(), Buffer.from([0xff]));
    expect(await inspectFolderCatalog()).toMatchObject({ kind: "damaged", reason: expect.stringContaining("UTF-8") });
  });

  test("oversize readable files receive exact-byte revisions instead of the unreadable sentinel", async () => {
    await isolate();
    await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
    await fs.writeFile(folderCatalogPath(), "x".repeat(FOLDER_CATALOG_MAX_BYTES + 1));
    const first = await inspectFolderCatalog();
    await fs.appendFile(folderCatalogPath(), "y");
    const second = await inspectFolderCatalog();
    expect(first).toMatchObject({ kind: "damaged", reason: expect.stringContaining("exceeds") });
    expect(second.kind).toBe("damaged");
    expect(first.revision).not.toBe(second.revision);
  });
});
