import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AccountWorkspace } from "./workspace-picker.js";
import {
  MARKER_NAME,
  defaultExportDir,
  exportSubdirName,
  runExportCore,
  sanitizeWorkspaceName,
  type ExportSeams,
} from "./export-cmd.js";

const ACCOUNT = "acct_0123456789abcdef";
const DATE = new Date(2026, 6, 4, 10, 20, 30);

function ws(workspaceId: string, name: string | null, projectId = "root"): AccountWorkspace {
  return { workspaceId, projectId, name, createdAt: 0 };
}

/** A fake pull that materializes `files` plus a `.rbox/` metadata dir into the
 *  staging root — exactly the shape a real pull leaves (design 65 §3), so the strip
 *  pass and the marker counts are exercised offline. */
function fakePull(filesByWs: Record<string, Record<string, string>>): ExportSeams["pullWorkspace"] {
  return async (stagingRoot, target) => {
    const files = filesByWs[target.workspaceId] ?? { "README.md": "hello\n" };
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(stagingRoot, rel);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, content);
    }
    await fs.mkdir(path.join(stagingRoot, ".rbox"), { recursive: true });
    await fs.writeFile(path.join(stagingRoot, ".rbox", "state.json"), "{}");
  };
}

function seamsFor(over: Partial<ExportSeams> & { list: AccountWorkspace[]; pull: ExportSeams["pullWorkspace"] }): ExportSeams {
  return {
    enrolled: true,
    homeDir: over.homeDir ?? "/nonexistent-home",
    now: () => DATE,
    listWorkspaces: async () => over.list,
    pullWorkspace: over.pull,
    tarGzip: over.tarGzip ?? (async () => {}),
    ...(over.onProgress ? { onProgress: over.onProgress } : {}),
  };
}

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-export-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("export subdir naming (design 65 §2)", () => {
  test("named workspace → sanitized-name + id8; unnamed → id8 only", () => {
    expect(exportSubdirName("My App", "ws_ab12cd34ef")).toBe("My-App-ws_ab12c");
    expect(exportSubdirName(null, "ws_ab12cd34ef")).toBe("ws_ab12c");
    expect(exportSubdirName("   ", "ws_ab12cd34ef")).toBe("ws_ab12c"); // all-unsafe name falls back to id
  });

  test("id suffix is mandatory so two same-named workspaces never collide", () => {
    const a = exportSubdirName("app", "ws_aaaa1111");
    const b = exportSubdirName("app", "ws_bbbb2222");
    expect(a).not.toBe(b);
  });

  test("sanitize strips path separators and leading/trailing junk", () => {
    expect(sanitizeWorkspaceName("../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeWorkspaceName(".hidden.")).toBe("hidden");
  });
});

describe("default path selection (design 58 reuse)", () => {
  test("prefers ~/Downloads only when it exists, else $HOME", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-home-"));
    try {
      const inHome = await defaultExportDir(ACCOUNT, DATE, home);
      expect(inHome).toBe(path.join(home, "rbox-export-0123456789abcdef-20260704"));

      await fs.mkdir(path.join(home, "Downloads"));
      const inDownloads = await defaultExportDir(ACCOUNT, DATE, home);
      expect(inDownloads).toBe(path.join(home, "Downloads", "rbox-export-0123456789abcdef-20260704"));
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("runExportCore", () => {
  test("exports every workspace to a clean tree with a completion marker; no .rbox leaks", async () => {
    const out = path.join(tmp, "export");
    const seams = seamsFor({
      list: [ws("ws_alpha001", "Alpha"), ws("ws_beta0002", null)],
      pull: fakePull({
        ws_alpha001: { "a.txt": "aaaa", "sub/b.txt": "bb" }, // 6 bytes, 2 files
        ws_beta0002: { "c.txt": "ccc" }, // 3 bytes, 1 file
      }),
    });

    const res = await runExportCore({ out }, ACCOUNT, seams);

    expect(res.outPath).toBe(out);
    const alphaDir = path.join(out, "Alpha-ws_alpha");
    const betaDir = path.join(out, "ws_beta0");
    expect(await fs.readFile(path.join(alphaDir, "a.txt"), "utf8")).toBe("aaaa");
    expect(await fs.readFile(path.join(alphaDir, "sub", "b.txt"), "utf8")).toBe("bb");
    expect(await fs.readFile(path.join(betaDir, "c.txt"), "utf8")).toBe("ccc");

    // Strip pass: NO .rbox metadata leaked into any export subdir.
    await expect(fs.stat(path.join(alphaDir, ".rbox"))).rejects.toThrow();
    await expect(fs.stat(path.join(betaDir, ".rbox"))).rejects.toThrow();

    const marker = JSON.parse(await fs.readFile(path.join(out, MARKER_NAME), "utf8"));
    expect(marker.account).toBe(ACCOUNT);
    expect(marker.workspaces).toHaveLength(2);
    expect(marker.files).toBe(3);
    expect(marker.bytes).toBe(9);
    expect(typeof marker.finishedAt).toBe("string");
    // No staging debris left beside the output.
    const siblings = await fs.readdir(tmp);
    expect(siblings.filter((s) => s.startsWith(".rbox-export-staging"))).toHaveLength(0);
  });

  test("--workspace narrows to a single workspace", async () => {
    const out = path.join(tmp, "one");
    const seams = seamsFor({
      list: [ws("ws_alpha001", "Alpha"), ws("ws_beta0002", "Beta")],
      pull: fakePull({ ws_beta0002: { "c.txt": "ccc" } }),
    });
    const res = await runExportCore({ out, workspaceId: "ws_beta0002" }, ACCOUNT, seams);
    expect(res.marker.workspaces).toHaveLength(1);
    expect(await fs.readdir(out)).toEqual(expect.arrayContaining(["Beta-ws_beta0", MARKER_NAME]));
    expect(await fs.readdir(out)).not.toContain("Alpha-ws_alpha");
  });

  test("refuses to overwrite an existing export directory", async () => {
    const out = path.join(tmp, "existing");
    await fs.mkdir(out);
    const seams = seamsFor({ list: [ws("ws_alpha001", "Alpha")], pull: fakePull({}) });
    await expect(runExportCore({ out }, ACCOUNT, seams)).rejects.toThrow(/overwrite/);
  });

  test("refuses to overwrite an existing tarball", async () => {
    const out = path.join(tmp, "backup.tar.gz");
    await fs.writeFile(out, "old");
    const seams = seamsFor({ list: [ws("ws_alpha001", "Alpha")], pull: fakePull({}) });
    await expect(runExportCore({ out }, ACCOUNT, seams)).rejects.toThrow(/overwrite/);
  });

  test("tarball mode builds an archive and writes the marker beside it", async () => {
    const out = path.join(tmp, "backup.tar.gz");
    let stagedEntries: string[] = [];
    const seams = seamsFor({
      list: [ws("ws_alpha001", "Alpha")],
      pull: fakePull({ ws_alpha001: { "a.txt": "aaaa" } }),
      tarGzip: async (stageDir, tarball) => {
        // Capture the tree WHILE it exists — the core removes staging on return.
        stagedEntries = await fs.readdir(stageDir);
        await fs.writeFile(tarball, "TARBALL");
      },
    });
    const res = await runExportCore({ out }, ACCOUNT, seams);
    expect(res.outPath).toBe(out);
    expect(await fs.readFile(out, "utf8")).toBe("TARBALL");
    expect(res.markerPath).toBe(path.join(tmp, `backup.${MARKER_NAME}`));
    const marker = JSON.parse(await fs.readFile(res.markerPath, "utf8"));
    expect(marker.files).toBe(1);
    // tar ran against the stripped staging tree.
    expect(stagedEntries).toContain("Alpha-ws_alpha");
  });

  test("a half-finished export leaves no marker and no destination", async () => {
    const out = path.join(tmp, "partial");
    let calls = 0;
    const seams = seamsFor({
      list: [ws("ws_alpha001", "Alpha"), ws("ws_beta0002", "Beta")],
      pull: async (stagingRoot, target, onProgress) => {
        calls++;
        if (target.workspaceId === "ws_beta0002") throw new Error("boom mid-pull");
        return fakePull({ ws_alpha001: { "a.txt": "aaaa" } })(stagingRoot, target, onProgress);
      },
    });
    await expect(runExportCore({ out }, ACCOUNT, seams)).rejects.toThrow(/boom/);
    expect(calls).toBe(2);
    // Neither the destination nor its marker was published.
    await expect(fs.stat(out)).rejects.toThrow();
    // And the staging dir was cleaned up (no half-written debris beside the target).
    const siblings = await fs.readdir(tmp);
    expect(siblings.filter((s) => s.startsWith(".rbox-export-staging"))).toHaveLength(0);
  });

  test("not enrolled → refuses with the recover hint and stages nothing", async () => {
    const out = path.join(tmp, "noenroll");
    const seams = seamsFor({ list: [ws("ws_alpha001", "Alpha")], pull: fakePull({}) });
    seams.enrolled = false;
    await expect(runExportCore({ out }, ACCOUNT, seams)).rejects.toThrow(/enrolled.*rbox recover|rbox recover/);
    await expect(fs.stat(out)).rejects.toThrow();
  });
});
