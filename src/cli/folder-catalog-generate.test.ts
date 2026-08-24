import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureFolderAuthority } from "./folder-authority.js";
import {
  deriveFolderLabel,
  generateFolderCatalog,
  initializeFolderCatalog,
  inspectFolderCatalog,
  parseFolderCatalog,
  resolveFolderPolicy,
  serializeFolderCatalog,
  snapshotPreCatalogPolicy,
  type FolderGenerationInventory,
} from "./folder-config.js";
import { folderCatalogPath } from "./rbox-paths.js";
import type { WorkspaceConfig } from "./workspace-config.js";

const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;
const roots: string[] = [];

async function isolate(): Promise<{ base: string; home: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-catalog-generate-"));
  const home = path.join(base, "home");
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

function binding(root: string, over: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    remoteWorkspaceId: `ws_${path.basename(root)}`,
    projectId: "root",
    deviceId: `dev_${path.basename(root)}`,
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
    ...over,
  };
}

async function inventory(bindings: WorkspaceConfig[], skipped: FolderGenerationInventory["skipped"] = []): Promise<FolderGenerationInventory> {
  const state = await inspectFolderCatalog();
  return {
    revision: state.revision,
    discoverableBindings: bindings.map((item) => ({ root: item.rootPath, binding: item })),
    skipped,
  };
}

test("label derivation handles roots, whitespace, NFD, scalar truncation, and exact collisions", () => {
  expect(deriveFolderLabel(path.parse(process.cwd()).root, new Set())).toBe("folder");
  expect(deriveFolderLabel("/tmp/   ", new Set())).toBe("folder");
  expect(deriveFolderLabel("/tmp/e\u0301", new Set())).toBe("é");
  const long = deriveFolderLabel(`/tmp/${"😀".repeat(200)}`, new Set());
  expect(Array.from(long)).toHaveLength(128);
  const taken = new Set(["Code", "Code (2)"]);
  expect(deriveFolderLabel("/tmp/Code", taken)).toBe("Code (3)");
  const suffixed = deriveFolderLabel(`/tmp/${"😀".repeat(200)}`, new Set([long]));
  expect(Array.from(suffixed).length).toBeLessThanOrEqual(128);
  expect(suffixed.endsWith(" (2)")).toBe(true);
});

test("generation sorts normalized paths before naming and emits complete reparsable policy", async () => {
  const { base } = await isolate();
  const later = binding(path.join(base, "z", "Code"), { syncGit: true, trash: { days: 2.9, maxBytes: Infinity } });
  const first = binding(path.join(base, "a", "Code"), { git: { incremental: false }, respectGitignore: true });
  const generated = generateFolderCatalog(await inventory([later, first], [{ root: "/dangling", reason: "missing" }]));
  expect(generated.catalog.folders.map((entry) => entry.name)).toEqual(["Code", "Code (2)"]);
  expect(generated.catalog.folders.map((entry) => entry.path)).toEqual([first.rootPath, later.rootPath]);
  expect(generated.catalog.folders[0]?.options).toEqual({
    syncGit: false,
    git: { incremental: false },
    respectGitignore: true,
    ignorePaths: [],
    noDrift: false,
    trash: { days: 30, maxBytes: 2147483648 },
  });
  const parsed = parseFolderCatalog(generated.bytes);
  expect(parsed).toEqual(generated.catalog);
  for (const [entry, source] of parsed.folders.map((entry, index) => [entry, [first, later][index]!] as const)) {
    expect(resolveFolderPolicy(parsed.globalOptions, entry.options)).toEqual(snapshotPreCatalogPolicy(source));
  }
  expect(generated.skipped).toEqual([{ root: "/dangling", reason: "missing" }]);
});

test("silent initialization requires zero skipped roots and adopts a hand-authored winner", async () => {
  await isolate();
  const empty = await inventory([]);
  const winner = serializeFolderCatalog({ schemaVersion: 1, globalOptions: {}, folders: [{ name: "Winner", path: "/winner" }] });
  const snapshot = await initializeFolderCatalog(empty, {
    publication: {
      onAtomicStep: async (step) => {
        if (step === "before-rename") await fs.writeFile(folderCatalogPath(), winner);
      },
    },
  });
  expect(snapshot.catalog.folders[0]?.name).toBe("Winner");
  await expect(initializeFolderCatalog(await inventory([], [{ root: "/dropped", reason: "the folder does not exist" }])))
    .rejects.toThrow(/zero skipped/);
});

test("two simultaneous first-run generators converge on one complete winner", async () => {
  await isolate();
  const state = await inspectFolderCatalog();
  const first: FolderGenerationInventory = {
    revision: state.revision,
    discoverableBindings: [{ root: "/first", binding: binding("/first") }],
    skipped: [],
  };
  const second: FolderGenerationInventory = {
    revision: state.revision,
    discoverableBindings: [{ root: "/second", binding: binding("/second") }],
    skipped: [],
  };
  const [left, right] = await Promise.all([initializeFolderCatalog(first), initializeFolderCatalog(second)]);
  expect(left.catalog).toEqual(right.catalog);
  expect((await inspectFolderCatalog()).kind).toBe("authoritative");
});

test("authority silently initializes a fresh machine and a lost catalog it can fully reproduce", async () => {
  const { base } = await isolate();
  expect((await ensureFolderAuthority()).snapshot.catalog.folders).toEqual([]);

  await fs.rm(folderCatalogPath());
  const bound = path.join(base, "bound");
  await fs.mkdir(path.join(bound, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(bound, ".rbox", "workspace.json"), JSON.stringify(binding(bound)));
  const healed = await ensureFolderAuthority({ currentRoot: bound });
  expect(healed.snapshot.catalog.folders.map((folder) => folder.path)).toEqual([bound]);
});

test("authority reports exact damaged reason and a repair-copy path", async () => {
  await isolate();
  await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
  await fs.writeFile(folderCatalogPath(), "{");
  await expect(ensureFolderAuthority()).rejects.toThrow(/Copy .*config\.json.*rbox config regenerate/);
});
