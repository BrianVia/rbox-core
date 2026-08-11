import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FolderCatalogStaleEditError,
  inspectFolderCatalog,
  parseFolderCatalog,
  publishNoReplace,
  publishReplacing,
  serializeFolderCatalog,
  type FolderCatalogAtomicStep,
  type FolderCatalogPublicationStep,
} from "./folder-config.js";
import { folderCatalogPath } from "./rbox-paths.js";

const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;
const roots: string[] = [];

async function isolate(nested = false): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-catalog-publish-"));
  const home = nested ? path.join(base, "new", "nested", "home") : path.join(base, "home");
  roots.push(base);
  process.env.HOME = home;
  process.env.RBOX_HOME = home;
  if (!nested) await fs.mkdir(home, { recursive: true });
  return home;
}

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = originalRboxHome;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function bytes(name = "A"): string {
  return serializeFolderCatalog({ schemaVersion: 1, globalOptions: {}, folders: [{ name, path: `/${name}` }] });
}

async function expectAbsentOrComplete(): Promise<void> {
  try {
    const current = await fs.readFile(folderCatalogPath(), "utf8");
    expect(() => parseFolderCatalog(current)).not.toThrow();
    expect((await fs.stat(folderCatalogPath())).mode & 0o777).toBe(0o600);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  }
}

test("no-replace publishes once and adopts a hand-authored winner without rewriting it", async () => {
  await isolate();
  expect((await publishNoReplace(bytes("A"))).kind).toBe("published");
  const exact = `${JSON.stringify({ schemaVersion: 1, globalOptions: {}, folders: [{ name: "A", path: "/A" }] })}  \n`;
  await fs.writeFile(folderCatalogPath(), exact);
  const result = await publishNoReplace(bytes("B"));
  expect(result.kind).toBe("existing");
  expect(result.snapshot.catalog.folders[0]?.name).toBe("A");
  expect(await fs.readFile(folderCatalogPath(), "utf8")).toBe(exact);
});

test("a stale temp-name collision is ignored without deleting the stale file", async () => {
  await isolate();
  let stale = "";
  let first = true;
  const result = await publishNoReplace(bytes(), {
    beforeTempOpen: async (temporary) => {
      if (!first) return;
      first = false;
      stale = temporary;
      await fs.writeFile(temporary, "stale crash temp");
    },
  });
  expect(result.kind).toBe("published");
  expect(await fs.readFile(stale, "utf8")).toBe("stale crash temp");
  const published = await fs.readFile(folderCatalogPath(), "utf8");
  expect(() => parseFolderCatalog(published)).not.toThrow();
});

test("a FIFO catalog path is inspected as damaged without blocking", async () => {
  await isolate();
  await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
  const made = Bun.spawnSync(["mkfifo", folderCatalogPath()]);
  if (made.exitCode !== 0) return;
  const state = await Promise.race([
    inspectFolderCatalog(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("FIFO inspection blocked")), 1_000)),
  ]);
  expect(state).toMatchObject({ kind: "damaged", reason: expect.stringContaining("not a regular file") });
});

test("replacing compares the opaque revision immediately before rename", async () => {
  await isolate();
  await publishNoReplace(bytes("A"));
  const state = await inspectFolderCatalog();
  if (state.kind !== "authoritative") throw new Error("expected catalog");
  await publishReplacing(state.revision, bytes("B"));
  await expect(publishReplacing(state.revision, bytes("C"))).rejects.toBeInstanceOf(FolderCatalogStaleEditError);

  const current = await inspectFolderCatalog();
  if (current.kind !== "authoritative") throw new Error("expected catalog");
  await expect(publishReplacing(current.revision, bytes("C"), {
    onAtomicStep: async (step) => {
      if (step === "temp-closed") await fs.writeFile(folderCatalogPath(), bytes("Editor"));
    },
  })).rejects.toBeInstanceOf(FolderCatalogStaleEditError);
  expect((await fs.readFile(folderCatalogPath(), "utf8"))).toBe(bytes("Editor"));
});

const atomicSteps: FolderCatalogAtomicStep[] = [
  "temp-opened", "temp-written", "temp-synced", "temp-closed", "before-rename", "after-rename",
];
for (const fault of atomicSteps) {
  test(`atomic publication fault at ${fault} leaves absence or a complete catalog`, async () => {
    await isolate();
    await expect(publishNoReplace(bytes(), {
      onAtomicStep: (step) => { if (step === fault) throw new Error(`fault:${step}`); },
    })).rejects.toThrow(`fault:${fault}`);
    await expectAbsentOrComplete();
  });
}

const durabilitySteps: FolderCatalogPublicationStep[] = [
  "before-write", "after-write", "before-directory-fsync", "after-directory-fsync",
];
for (const fault of durabilitySteps) {
  test(`durability fault at ${fault} leaves absence or a complete catalog`, async () => {
    await isolate();
    await expect(publishNoReplace(bytes(), {
      onStep: (step) => { if (step === fault) throw new Error(`fault:${step}`); },
    })).rejects.toThrow(`fault:${fault}`);
    await expectAbsentOrComplete();
  });
}

for (const fault of atomicSteps) {
  test(`replacement atomic fault at ${fault} preserves a complete prior or next catalog`, async () => {
    await isolate();
    await publishNoReplace(bytes("Prior"));
    const state = await inspectFolderCatalog();
    if (state.kind !== "authoritative") throw new Error("expected catalog");
    await expect(publishReplacing(state.revision, bytes("Next"), {
      onAtomicStep: (step) => { if (step === fault) throw new Error(`replace-fault:${step}`); },
    })).rejects.toThrow(`replace-fault:${fault}`);
    const current = parseFolderCatalog(await fs.readFile(folderCatalogPath(), "utf8"));
    expect(["Prior", "Next"]).toContain(current.folders[0]?.name);
  });
}

for (const fault of durabilitySteps) {
  test(`replacement durability fault at ${fault} preserves a complete prior or next catalog`, async () => {
    await isolate();
    await publishNoReplace(bytes("Prior"));
    const state = await inspectFolderCatalog();
    if (state.kind !== "authoritative") throw new Error("expected catalog");
    await expect(publishReplacing(state.revision, bytes("Next"), {
      onStep: (step) => { if (step === fault) throw new Error(`replace-fault:${step}`); },
    })).rejects.toThrow(`replace-fault:${fault}`);
    const current = parseFolderCatalog(await fs.readFile(folderCatalogPath(), "utf8"));
    expect(["Prior", "Next"]).toContain(current.folders[0]?.name);
  });
}

for (const directoryStep of ["after-create", "after-created-ancestor-fsync"] as const) {
  for (let occurrence = 1; occurrence <= 4; occurrence++) {
    test(`fresh-directory fault at ${directoryStep} ${occurrence} retries to durable catalog`, async () => {
      await isolate(true);
      let seen = 0;
      await expect(publishNoReplace(bytes(), {
        onDirectoryStep: (step, directory) => {
          if (step !== directoryStep) return;
          expect(path.isAbsolute(directory)).toBe(true);
          seen++;
          if (seen === occurrence) throw new Error(`fresh-dir-fault:${step}:${occurrence}`);
        },
      })).rejects.toThrow(`fresh-dir-fault:${directoryStep}:${occurrence}`);
      expect(seen).toBe(occurrence);
      await expectAbsentOrComplete();
      expect((await publishNoReplace(bytes())).snapshot.catalog.folders).toHaveLength(1);
    });
  }
}

test("two fresh-chain publishers cover a split mkdir race and publish exactly once", async () => {
  await isolate(true);
  let resumeFirst!: () => void;
  const firstMayResume = new Promise<void>((resolve) => { resumeFirst = resolve; });
  let announceFirst!: () => void;
  const firstCreated = new Promise<void>((resolve) => { announceFirst = resolve; });
  let firstCreateCount = 0;
  let firstAncestorFsyncs = 0;
  let writes = 0;
  const first = publishNoReplace(bytes("First"), {
    onDirectoryStep: async (step) => {
      if (step === "after-create" && ++firstCreateCount === 1) {
        announceFirst();
        await firstMayResume;
      }
      if (step === "after-created-ancestor-fsync") firstAncestorFsyncs++;
    },
    onStep: (step) => { if (step === "before-write") writes++; },
  });
  await firstCreated;
  const second = publishNoReplace(bytes("Second"), {
    onStep: (step) => { if (step === "before-write") writes++; },
  });
  const secondResult = await second;
  resumeFirst();
  const firstResult = await first;
  expect([firstResult.kind, secondResult.kind].sort()).toEqual(["existing", "published"]);
  expect(writes).toBe(1);
  expect(firstAncestorFsyncs).toBe(4);
  const published = await fs.readFile(folderCatalogPath(), "utf8");
  expect(() => parseFolderCatalog(published)).not.toThrow();
});
