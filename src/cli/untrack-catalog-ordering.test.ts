import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPersistedEntries } from "./binding-registry.js";
import { inspectFolderCatalog, recordFolder } from "./folder-config.js";
import { main } from "./main-dispatch.js";
import { daemonRuntimeDir } from "./rbox-paths.js";
import { track } from "./track-cmd.js";
import { untrack, type UntrackStep } from "./untrack-cmd.js";

let home: string;
let scratch: string;
const originalArgv = process.argv;
const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-untrack-order-home-"));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-untrack-order-roots-"));
  process.env.HOME = home;
  process.env.RBOX_HOME = home;
});

afterEach(async () => {
  process.argv = originalArgv;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = originalRboxHome;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(scratch, { recursive: true, force: true });
});

async function catalogHas(root: string): Promise<boolean> {
  const state = await inspectFolderCatalog();
  return state.kind === "authoritative"
    && state.snapshot.folders.some((folder) => folder.normalizedPath === path.resolve(root));
}

async function absent(target: string): Promise<boolean> {
  return fs.access(target).then(() => false, () => true);
}

test("each untrack crash boundary preserves user data and retry converges", async () => {
  const faults: UntrackStep[] = [
    "daemon-stopped",
    "binding-removed",
    "runtime-removed",
    "catalog-forgotten",
    "registry-forgotten",
  ];
  for (const [index, fault] of faults.entries()) {
    const root = path.join(scratch, `case-${index}`);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "keep.txt"), "user data");
    await track(root, { workspace: `ws_${index}` }, "https://api.test");
    await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
    await fs.writeFile(path.join(daemonRuntimeDir(root), "daemon.log"), "log");
    const seen: UntrackStep[] = [];
    await expect(untrack({ root, force: true }, {
      onStep: (step) => {
        seen.push(step);
        if (step === fault) throw new Error(`fault:${step}`);
      },
    })).rejects.toThrow(`fault:${fault}`);
    expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("user data");
    await untrack({ root, force: true }).catch((error: unknown) => {
      if (fault !== "registry-forgotten" || !(error instanceof Error) || !error.message.includes("nothing to untrack")) throw error;
    });
    expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("user data");
    expect(await absent(path.join(root, ".rbox"))).toBe(true);
    expect(await absent(daemonRuntimeDir(root))).toBe(true);
    expect(await catalogHas(root)).toBe(false);
    expect((await readPersistedEntries()).some((entry) => entry.root === root)).toBe(false);
    expect(seen.at(-1)).toBe(fault);
  }
});

test("catalog-only roots converge across every crash boundary", async () => {
  const faults: UntrackStep[] = [
    "daemon-stopped",
    "binding-removed",
    "runtime-removed",
    "catalog-forgotten",
    "registry-forgotten",
  ];
  const { forgetBinding } = await import("./binding-registry.js");
  for (const [index, fault] of faults.entries()) {
    const root = path.join(scratch, `catalog-only-${index}`);
    await fs.mkdir(root, { recursive: true });
    // Initialize through a normal bind, then remove binding + compatibility row
    // to model a hand-cleaned catalog-only entry.
    await track(root, { workspace: `ws_catalog_${index}` }, "https://api.test");
    await fs.rm(path.join(root, ".rbox"), { recursive: true });
    await forgetBinding(root);
    await expect(untrack({ root, force: true }, {
      onStep: (step) => { if (step === fault) throw new Error(`fault:${step}`); },
    })).rejects.toThrow(`fault:${fault}`);
    await untrack({ root, force: true }).catch((error: unknown) => {
      const alreadyConverged = fault === "catalog-forgotten" || fault === "registry-forgotten";
      if (!alreadyConverged || !(error instanceof Error) || !error.message.includes("nothing to untrack")) throw error;
    });
    expect(await catalogHas(root)).toBe(false);
    expect((await readPersistedEntries()).some((entry) => entry.root === root)).toBe(false);
  }
});

test("dispatcher never walks from a catalog-only descendant to its bound ancestor", async () => {
  const ancestor = path.join(scratch, "ancestor");
  const descendant = path.join(ancestor, "descendant");
  await fs.mkdir(descendant, { recursive: true });
  await fs.writeFile(path.join(ancestor, "keep.txt"), "ancestor data");
  await track(ancestor, { workspace: "ws_ancestor" }, "https://api.test");
  await recordFolder(descendant);

  process.argv = [process.execPath, "rbox", "untrack", descendant, "--force"];
  await main({ refreshSystemLockIdentityLedger: async () => {} });

  expect(await catalogHas(descendant)).toBe(false);
  expect(await fs.readFile(path.join(ancestor, "keep.txt"), "utf8")).toBe("ancestor data");
  expect(await absent(path.join(ancestor, ".rbox", "workspace.json"))).toBe(false);
});
