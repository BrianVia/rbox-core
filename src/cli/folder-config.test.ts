import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_FOLDER_POLICY,
  FOLDER_CATALOG_MAX_BYTES,
  FolderCatalogStaleEditError,
  buildFolderCatalogCandidate,
  collapseFolderPath,
  expandFolderPath,
  folderCatalogGeneration,
  inspectFolderCatalog,
  parseFolderCatalog,
  publishInitialFolderCatalog as publishInitialFolderCatalogImpl,
  readFolderCatalog,
  resolveFolderPolicy,
  serializeFolderCatalog,
  type FolderCatalog,
  type FolderCatalogAtomicStep,
  type FolderCatalogCandidate,
  type FolderCatalogPublicationOptions,
  type FolderCatalogPublicationStep,
} from "./folder-config.js";
import { folderCatalogAuthorityPath, folderCatalogPath } from "./rbox-paths.js";

const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;
const roots: string[] = [];
const TEST_LOCK = {
  identity: {
    current: async () => ({ hostId: "aa", bootId: "bb", pid: process.pid, startTime: "1" }),
    probe: async () => ({ status: "alive" as const, startTime: "1" }),
  },
  storageLocal: async () => true,
  skipIdentityRefresh: true,
};

function publishInitialFolderCatalog(
  candidate: FolderCatalogCandidate,
  options: FolderCatalogPublicationOptions = {},
) {
  return publishInitialFolderCatalogImpl(candidate, { ...options, lock: TEST_LOCK });
}

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
  process.env.HOME = originalHome;
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

describe("closed bounded folder catalog codec", () => {
  test("accepts the normative schema and preserves stored spelling", async () => {
    const { home } = await isolate();
    const value = catalog({
      globalOptions: {
        syncGit: true,
        git: { incremental: false },
        respectGitignore: false,
        noDrift: true,
        trash: { days: 0, maxBytes: 0 },
      },
      folders: [{
        name: "Development",
        path: "~/Development/../Development",
        options: { syncGit: false, trash: { days: 14 } },
      }],
    });
    const parsed = parseFolderCatalog(serializeFolderCatalog(value, home), home);
    expect(parsed).toEqual(value);
    expect(expandFolderPath(parsed.folders[0]!.path, home)).toBe(path.join(home, "Development"));
  });

  test("rejects unknown and null values at every options level", async () => {
    const { home } = await isolate();
    const invalid = [
      { ...catalog(), extra: true },
      { ...catalog(), globalOptions: { pullOnly: true } },
      { ...catalog(), globalOptions: { git: { incremental: true, scope: [] } } },
      { ...catalog(), globalOptions: { trash: { days: 2, extra: 1 } } },
      { ...catalog(), globalOptions: { trash: null } },
      { ...catalog(), folders: [{ name: "Development", path: "~/Development", extra: true }] },
    ];
    for (const value of invalid) expect(() => parseFolderCatalog(JSON.stringify(value), home)).toThrow();
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

  test("enforces name scalar, NFC, whitespace, path, folder-count, and byte bounds", async () => {
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

  test("rejects exact name and normalized-path duplicates but accepts nested roots", async () => {
    const { home } = await isolate();
    expect(() => parseFolderCatalog(JSON.stringify(catalog({ folders: [
      { name: "Development", path: "~/Development" },
      { name: "Development", path: "~/Other" },
    ] })), home)).toThrow(/duplicates the exact local name/);
    expect(() => parseFolderCatalog(JSON.stringify(catalog({ folders: [
      { name: "Development", path: "~/Development" },
      { name: "Alias", path: `${home}/Development/../Development` },
    ] })), home)).toThrow(/duplicates normalized path/);
    expect(() => parseFolderCatalog(JSON.stringify(catalog({ folders: [
      { name: "Development", path: "~/Development" },
      { name: "Trailing", path: `${home}/Development/` },
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
});

describe("path and option primitives", () => {
  test("expands and collapses only paths on the home boundary", async () => {
    const { base, home } = await isolate();
    expect(expandFolderPath("~", home)).toBe(home);
    expect(expandFolderPath("~/Development/../Code", home)).toBe(path.join(home, "Code"));
    expect(collapseFolderPath(home, home)).toBe("~");
    expect(collapseFolderPath(path.join(home, "Development"), home)).toBe("~/Development");
    expect(collapseFolderPath(path.join(base, "user-copy"), home)).toBe(path.join(base, "user-copy"));
  });

  test("resolves every nested field independently and preserves false and zero", () => {
    expect(resolveFolderPolicy(
      { syncGit: false, git: { incremental: false }, trash: { days: 20, maxBytes: 100 } },
      { syncGit: true, respectGitignore: true, noDrift: true, trash: { days: 0 } },
    )).toEqual({
      syncGit: true,
      git: { incremental: false },
      respectGitignore: true,
      noDrift: true,
      trash: { days: 0, maxBytes: 100 },
    });
    expect(resolveFolderPolicy({}, {})).toEqual(DEFAULT_FOLDER_POLICY);
  });

  test("pure candidate construction refuses unavailable policy unless explicitly skipped", async () => {
    const { home } = await isolate();
    const seeds = [
      { name: "Development", path: path.join(home, "Development"), policy: { kind: "available" as const, options: { syncGit: false } } },
      { name: "Missing", path: path.join(home, "Missing"), policy: { kind: "unavailable" as const, reason: "binding is missing" } },
    ];
    expect(() => buildFolderCatalogCandidate(seeds, {}, { home })).toThrow(/restore it or explicitly skip/);
    const candidate = buildFolderCatalogCandidate(seeds, {}, { home, skipUnavailable: true });
    expect(candidate.catalog.folders).toEqual([{ name: "Development", path: "~/Development", options: { syncGit: false } }]);
    expect(candidate.skippedUnavailable).toEqual([{ name: "Missing", path: path.join(home, "Missing"), reason: "binding is missing" }]);
  });
});

describe("authority state and durable publication", () => {
  test("distinguishes legacy, candidate, authoritative, and damaged state", async () => {
    await isolate();
    expect(await inspectFolderCatalog()).toEqual({ kind: "legacy" });

    const bytes = serializeFolderCatalog(catalog());
    await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
    await fs.writeFile(folderCatalogPath(), bytes);
    const candidateState = await inspectFolderCatalog();
    expect(candidateState.kind).toBe("candidate");
    if (candidateState.kind !== "candidate") throw new Error("expected candidate");
    await publishInitialFolderCatalog(candidateState.candidate, { now: () => new Date("2026-08-11T12:00:00.000Z") });
    const active = await inspectFolderCatalog();
    expect(active.kind).toBe("authoritative");
    if (active.kind === "authoritative") expect(active.activatedAt).toBe("2026-08-11T12:00:00.000Z");
    expect((await readFolderCatalog()).catalog).toEqual(catalog());

    await fs.writeFile(folderCatalogPath(), "not json");
    expect(await inspectFolderCatalog()).toMatchObject({ kind: "damaged", authorityActivated: true });
    await expect(readFolderCatalog()).rejects.toThrow(/damaged/);
  });

  test("a corrupt unactivated candidate is damaged without activating authority", async () => {
    await isolate();
    await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
    await fs.writeFile(folderCatalogPath(), "{");
    expect(await inspectFolderCatalog()).toMatchObject({ kind: "damaged", authorityActivated: false });
    await fs.writeFile(folderCatalogPath(), "x".repeat(FOLDER_CATALOG_MAX_BYTES + 1));
    expect(await inspectFolderCatalog()).toMatchObject({ kind: "damaged", authorityActivated: false });
    await fs.writeFile(folderCatalogPath(), Buffer.from([0xff]));
    expect(await inspectFolderCatalog()).toMatchObject({ kind: "damaged", authorityActivated: false });
  });

  test("a marker without config and malformed marker both fail closed", async () => {
    await isolate();
    await fs.mkdir(path.dirname(folderCatalogAuthorityPath()), { recursive: true });
    await fs.writeFile(folderCatalogAuthorityPath(), JSON.stringify({ schemaVersion: 1, activatedAt: new Date().toISOString() }));
    expect(await inspectFolderCatalog()).toMatchObject({ kind: "damaged", authorityActivated: true });
    await fs.writeFile(folderCatalogAuthorityPath(), JSON.stringify({ schemaVersion: 1, activatedAt: new Date().toISOString(), extra: true }));
    expect(await inspectFolderCatalog()).toMatchObject({ kind: "damaged", authorityActivated: true });
    await fs.writeFile(folderCatalogAuthorityPath(), JSON.stringify({ schemaVersion: 1, activatedAt: "2026-08-11" }));
    expect(await inspectFolderCatalog()).toMatchObject({ kind: "damaged", authorityActivated: true });
  });

  test("generated publication writes private config then marker and returns the pinned generation", async () => {
    const { home } = await isolate();
    const candidate = buildFolderCatalogCandidate([
      { name: "Development", path: path.join(home, "Development"), policy: { kind: "available", options: { noDrift: true } } },
    ], { respectGitignore: true }, { home });
    const snapshot = await publishInitialFolderCatalog(candidate, { now: () => new Date("2026-08-11T00:00:00.000Z") });
    expect(snapshot.generation).toBe(candidate.generation);
    expect(snapshot.folders[0]).toMatchObject({
      name: "Development",
      normalizedPath: path.join(home, "Development"),
      policy: { respectGitignore: true, noDrift: true },
    });
    expect((await fs.stat(folderCatalogPath())).mode & 0o777).toBe(0o600);
    expect((await fs.stat(folderCatalogAuthorityPath())).mode & 0o777).toBe(0o600);
    expect(await inspectFolderCatalog()).toMatchObject({ kind: "authoritative", activatedAt: "2026-08-11T00:00:00.000Z" });
    await expect(publishInitialFolderCatalog(candidate)).rejects.toBeInstanceOf(FolderCatalogStaleEditError);
  });

  test("activation marker does not pin mutable config bytes", async () => {
    await isolate();
    await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
    await fs.writeFile(folderCatalogPath(), serializeFolderCatalog(catalog()));
    const candidateState = await inspectFolderCatalog();
    if (candidateState.kind !== "candidate") throw new Error("expected candidate");
    await publishInitialFolderCatalog(candidateState.candidate, {
      now: () => new Date("2026-08-11T12:00:00.000Z"),
    });

    const edited = serializeFolderCatalog(catalog({
      globalOptions: { syncGit: false },
    }));
    await fs.writeFile(folderCatalogPath(), edited);
    const state = await inspectFolderCatalog();
    expect(state.kind).toBe("authoritative");
    if (state.kind !== "authoritative") throw new Error("expected authoritative");
    expect(state.activatedAt).toBe("2026-08-11T12:00:00.000Z");
    expect(state.snapshot.generation).toBe(folderCatalogGeneration(edited));
    expect(state.snapshot.folders[0]?.policy.syncGit).toBe(false);
  });

  test("hand-authored publication preserves exact validated bytes", async () => {
    await isolate();
    await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
    const bytes = `${JSON.stringify(catalog())}  \n`;
    await fs.writeFile(folderCatalogPath(), bytes);
    const state = await inspectFolderCatalog();
    if (state.kind !== "candidate") throw new Error("expected candidate");
    await publishInitialFolderCatalog(state.candidate);
    expect(await fs.readFile(folderCatalogPath(), "utf8")).toBe(bytes);
  });

  test("a config-first interrupted publication resumes from the observed candidate", async () => {
    const { home } = await isolate();
    const generated = buildFolderCatalogCandidate([
      { name: "Development", path: path.join(home, "Development"), policy: { kind: "available" } },
    ], {}, { home });
    await expect(publishInitialFolderCatalog(generated, {
      onStep: (step) => { if (step === "before-marker-write") throw new Error("interrupt"); },
    })).rejects.toThrow("interrupt");

    const interrupted = await inspectFolderCatalog();
    if (interrupted.kind !== "candidate") throw new Error("expected recoverable candidate");
    await publishInitialFolderCatalog(interrupted.candidate);
    expect(await inspectFolderCatalog()).toMatchObject({ kind: "authoritative" });
  });

  test("global lock comparison rejects stale generated and hand-authored candidates", async () => {
    const { home } = await isolate();
    const generated = buildFolderCatalogCandidate([
      { name: "Development", path: path.join(home, "Development"), policy: { kind: "available" } },
    ], {}, { home });
    await expect(publishInitialFolderCatalog(generated, {
      onStep: async (step) => {
        if (step === "before-config-write") await fs.writeFile(folderCatalogPath(), serializeFolderCatalog(catalog()));
      },
    })).rejects.toBeInstanceOf(FolderCatalogStaleEditError);

    const state = await inspectFolderCatalog();
    expect(state.kind).toBe("candidate");
    if (state.kind !== "candidate") throw new Error("expected candidate");
    await expect(publishInitialFolderCatalog(state.candidate, {
      onStep: async (step) => {
        if (step === "before-marker-write") await fs.appendFile(folderCatalogPath(), " \n");
      },
    })).rejects.toBeInstanceOf(FolderCatalogStaleEditError);
    expect(await inspectFolderCatalog()).toMatchObject({ kind: "candidate" });
  });

  const configAtomicSteps: FolderCatalogAtomicStep[] = [
    "temp-opened", "temp-written", "temp-synced", "temp-closed", "before-rename", "after-rename",
  ];
  for (const faultStep of configAtomicSteps) {
    test(`config atomic fault at ${faultStep} never publishes authority first`, async () => {
      const { home } = await isolate();
      const candidate = buildFolderCatalogCandidate([
        { name: "Development", path: path.join(home, "Development"), policy: { kind: "available" } },
      ], {}, { home });
      await expect(publishInitialFolderCatalog(candidate, {
        onAtomicStep: (target, step) => {
          if (target === "config" && step === faultStep) throw new Error(`fault:${step}`);
        },
      })).rejects.toThrow(`fault:${faultStep}`);
      const state = await inspectFolderCatalog();
      expect(state.kind).toBe(faultStep === "after-rename" ? "candidate" : "legacy");
    });
  }

  const configDurabilitySteps: FolderCatalogPublicationStep[] = [
    "before-config-directory-fsync", "after-config-directory-fsync", "before-marker-write",
  ];
  for (const faultStep of configDurabilitySteps) {
    test(`publication fault at ${faultStep} leaves a recoverable candidate`, async () => {
      const { home } = await isolate();
      const candidate = buildFolderCatalogCandidate([
        { name: "Development", path: path.join(home, "Development"), policy: { kind: "available" } },
      ], {}, { home });
      await expect(publishInitialFolderCatalog(candidate, {
        onStep: (step) => { if (step === faultStep) throw new Error(`fault:${step}`); },
      })).rejects.toThrow(`fault:${faultStep}`);
      expect(await inspectFolderCatalog()).toMatchObject({ kind: "candidate" });
    });
  }

  const markerAtomicSteps: FolderCatalogAtomicStep[] = [
    "temp-opened", "temp-written", "temp-synced", "temp-closed", "before-rename", "after-rename",
  ];
  for (const faultStep of markerAtomicSteps) {
    test(`marker atomic fault at ${faultStep} respects config-before-marker order`, async () => {
      await isolate();
      await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
      await fs.writeFile(folderCatalogPath(), serializeFolderCatalog(catalog()));
      const state = await inspectFolderCatalog();
      if (state.kind !== "candidate") throw new Error("expected candidate");
      await expect(publishInitialFolderCatalog(state.candidate, {
        onAtomicStep: (target, step) => {
          if (target === "marker" && step === faultStep) throw new Error(`fault:${step}`);
        },
      })).rejects.toThrow(`fault:${faultStep}`);
      expect(await inspectFolderCatalog()).toMatchObject({ kind: faultStep === "after-rename" ? "authoritative" : "candidate" });
    });
  }

  for (const faultStep of ["before-marker-directory-fsync", "after-marker-directory-fsync"] as const) {
    test(`marker durability fault at ${faultStep} never loses the validated config`, async () => {
      const { home } = await isolate();
      const candidate = buildFolderCatalogCandidate([
        { name: "Development", path: path.join(home, "Development"), policy: { kind: "available" } },
      ], {}, { home });
      await expect(publishInitialFolderCatalog(candidate, {
        onStep: (step) => { if (step === faultStep) throw new Error(`fault:${step}`); },
      })).rejects.toThrow(`fault:${faultStep}`);
      expect(await inspectFolderCatalog()).toMatchObject({ kind: "authoritative" });
    });
  }
});
