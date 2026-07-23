import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { caseCollisionEventsRequireScan, RboxDaemon } from "./daemon.js";
import { readPathWarnings, savePathWarnings } from "../path-warnings.js";

const groups = [{ paths: ["Parent/Lucky Meat.md", "Parent/Lucky meat.md"] }];

test("active case collisions force scans for member and ancestor directory events", () => {
  expect(caseCollisionEventsRequireScan(groups, [{ relPath: "Parent/Lucky Meat.md", kind: "unlink" }])).toBe(true);
  expect(caseCollisionEventsRequireScan(groups, [{ relPath: "Parent/Lucky Meat.md", kind: "change" }])).toBe(true);
  expect(caseCollisionEventsRequireScan(groups, [{ relPath: "parent", kind: "unlinkDir" }])).toBe(true);
  expect(caseCollisionEventsRequireScan(groups, [{ relPath: "Parent/Lucky Meat.md/child", kind: "unlinkDir" }])).toBe(true);
  expect(caseCollisionEventsRequireScan(groups, [{ relPath: "Other/file.txt", kind: "change" }])).toBe(false);
});

test("daemon path-warning episodes dedupe, transition, clear, and reappear", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-case-warning-daemon-"));
  const lines: string[] = [];
  const cfg = {
    remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root,
    remoteUrl: "https://example.invalid", token: "", encrypted: true,
  };
  const daemon = new RboxDaemon(root, cfg as never, {}, { log: (line) => lines.push(line) }) as unknown as {
    observeCaseCollisions(observation: { authority: "authoritative"; caseCollisions: Array<{ paths: string[] }> }): Promise<void>;
  };
  const a = [{ paths: ["A", "a"] }];
  const b = [{ paths: ["B", "b"] }];
  try {
    await daemon.observeCaseCollisions({ authority: "authoritative", caseCollisions: a });
    const firstInode = (await fs.stat(path.join(root, ".rbox", "state", "path-warnings.json"))).ino;
    await daemon.observeCaseCollisions({ authority: "authoritative", caseCollisions: a });
    expect((await fs.stat(path.join(root, ".rbox", "state", "path-warnings.json"))).ino).toBe(firstInode);
    await savePathWarnings(root, b); // foreground writer changes durable truth
    await daemon.observeCaseCollisions({ authority: "authoritative", caseCollisions: a });
    expect((await readPathWarnings(root))?.collisions).toEqual(a);
    await daemon.observeCaseCollisions({ authority: "authoritative", caseCollisions: b });
    await daemon.observeCaseCollisions({ authority: "authoritative", caseCollisions: [] });
    expect(await readPathWarnings(root)).toBeUndefined();
    await daemon.observeCaseCollisions({ authority: "authoritative", caseCollisions: a });
    expect(lines.filter((line) => line.startsWith("path warning:"))).toHaveLength(4);
    expect((await readPathWarnings(root))?.groupCount).toBe(1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed-attempt observations conservatively retain incomplete authority", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-case-warning-authority-"));
  const cfg = {
    remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root,
    remoteUrl: "https://example.invalid", token: "", encrypted: true,
  };
  const daemon = new RboxDaemon(root, cfg as never, {}, { log: () => {} }) as unknown as {
    manifestObservationComplete: boolean;
    activeCaseCollisions: Array<{ paths: string[] }>;
    observeCaseCollisions(observation: { authority: "authoritative" | "preserve"; caseCollisions: Array<{ paths: string[] }> }): Promise<void>;
  };
  try {
    await savePathWarnings(root, groups);
    expect(daemon.manifestObservationComplete).toBe(true);

    await daemon.observeCaseCollisions({ authority: "preserve", caseCollisions: groups });
    expect(daemon.manifestObservationComplete).toBe(false);
    expect(daemon.activeCaseCollisions).toEqual(groups);
    expect((await readPathWarnings(root))?.collisions).toEqual(groups);

    await daemon.observeCaseCollisions({ authority: "authoritative", caseCollisions: [] });
    expect(daemon.manifestObservationComplete).toBe(false);
    expect(daemon.activeCaseCollisions).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
