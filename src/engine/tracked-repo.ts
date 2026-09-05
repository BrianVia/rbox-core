// Never: decide ignore precedence or discover repositories.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import { jsonCounter, jsonObject, jsonText, type JsonValue } from "../json.js";

export interface TrackedRepoSet {
  relPath: string;
  paths: Set<string>;
  dirPrefixes: Set<string>;
  known: boolean;
  available: boolean;
}

/**
 * Two outcomes, never one (design 224 §2.1). `indexUnreadable` keeps the historic
 * fail-open (`available: false` ⇒ "possibly tracked" ⇒ un-ignored and unprunable).
 * `indexAbsent` — a repo that git resolved, whose index is genuinely `ENOENT`, and
 * which has NO commits — has an EMPTY tracked set, not an unknown one, so it must
 * not un-ignore its own `node_modules`/`venv`/`.env`.
 *
 * All three signals are load-bearing. A repo that HAS commits but whose index was
 * deleted also yields ∅ from `git ls-files --cached`, yet its true tracked set is
 * non-empty; classifying it `indexAbsent` would let `rbox ignore --purge` delete
 * committed files fleet-wide.
 */
export function loadTrackedRepoSet(root: string, relPath: string, known: boolean): TrackedRepoSet {
  const repoDir = relPath === "." ? root : path.join(root, relPath);
  const indexUnreadable = (): TrackedRepoSet => ({ relPath, paths: new Set(), dirPrefixes: new Set(), known, available: false });
  // One retry covers index changes during cache read or native enumeration.
  for (let attempt = 0; attempt < 2; attempt++) {
    const indexPath = gitOutput(repoDir, ["rev-parse", "--git-path", "index"]);
    if (!indexPath) return indexUnreadable();
    const resolvedIndex = path.resolve(repoDir, indexPath);
    const before = safeStat(resolvedIndex);
    if (before.kind === "absent") {
      const unbornHead = gitOutput(repoDir, ["rev-parse", "--quiet", "--verify", "HEAD"]) === undefined;
      return unbornHead ? availableTrackedRepo(relPath, [], known) : indexUnreadable();
    }
    if (before.kind === "error") return indexUnreadable();
    const cacheFile = trackedCachePath(root, relPath, resolvedIndex);
    const cached = readTrackedCache(cacheFile, resolvedIndex, before.identity);
    if (cached.kind === "corrupt") return indexUnreadable();
    if (cached.kind === "hit") {
      const after = safeStat(resolvedIndex);
      if (after.kind === "ok" && sameIndexIdentity(before.identity, after.identity)) {
        return availableTrackedRepo(relPath, cached.paths, known);
      }
      continue;
    }
    const shared = gitOutput(repoDir, ["rev-parse", "--shared-index-path"]);
    const validShared =
      shared !== undefined && (shared === "" || /^sharedindex\.(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(path.basename(shared)));
    const raw = validShared ? gitOutput(repoDir, ["ls-files", "-z", "--cached"]) : undefined;
    const after = safeStat(resolvedIndex);
    if (after.kind !== "ok" || !sameIndexIdentity(before.identity, after.identity)) continue;
    if (shared === undefined || raw === undefined) return indexUnreadable();
    const paths = raw
      .split("\0")
      .filter(Boolean)
      .map((p) => p.replace(/\\/g, "/"));
    // Native reads refresh sharedindex timestamps, so split indexes stay uncached.
    // With split reads enabled Git names the null OID for an ordinary index.
    if (shared === "" || /^sharedindex\.(?:0{40}|0{64})$/.test(path.basename(shared))) {
      writeTrackedCache(cacheFile, { version: 2, indexPath: resolvedIndex, identity: after.identity, dependency: "none", paths });
    }
    return availableTrackedRepo(relPath, paths, known);
  }
  return indexUnreadable();
}

function availableTrackedRepo(relPath: string, paths: string[], known: boolean): TrackedRepoSet {
  return { relPath, paths: new Set(paths), dirPrefixes: trackedDirPrefixes(relPath, paths), known, available: true };
}

function trackedDirPrefixes(repoRel: string, paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const localPath of paths) {
    const clean = localPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!clean) continue;
    const workspacePath = repoRel === "." ? clean : `${repoRel}/${clean}`;
    const parts = workspacePath.split("/");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return out;
}

/** Errno-aware stat: `absent` is ENOENT SPECIFICALLY, and is the only stat outcome
 *  that can positively classify a missing index. Every other failure is `error`. */
type IndexIdentity = { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string };
type SafeStatResult = { kind: "ok"; identity: IndexIdentity } | { kind: "absent" } | { kind: "error" };

function safeStat(filePath: string): SafeStatResult {
  try {
    const st = fs.statSync(filePath, { bigint: true });
    if (!st.isFile()) return { kind: "error" };
    return {
      kind: "ok",
      identity: {
        dev: st.dev.toString(),
        ino: st.ino.toString(),
        size: st.size.toString(),
        mtimeNs: st.mtimeNs.toString(),
        ctimeNs: st.ctimeNs.toString()
      }
    };
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "absent" } : { kind: "error" };
  }
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  // Pin index reads: repository config must not hide split dependencies or run fsmonitor hooks.
  const res = childProcess.spawnSync(
    "git",
    ["-c", "core.splitIndex=true", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=keep", ...args],
    { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
  );
  if (res.status !== 0) return undefined;
  return res.stdout.endsWith("\n") ? res.stdout.slice(0, -1) : res.stdout;
}

interface TrackedCacheFile {
  version: 2;
  indexPath: string;
  identity: IndexIdentity;
  dependency: "none";
  paths: string[];
}

function trackedCachePath(root: string, relPath: string, indexPath: string): string {
  const key = crypto.createHash("sha256").update(`${relPath}\0${indexPath}`).digest("hex");
  return path.join(root, ".rbox", "state", "git-tracked", `${key}.json`);
}

type TrackedCacheRead = { kind: "hit"; paths: string[] } | { kind: "miss" } | { kind: "corrupt" };

function sameIndexIdentity(a: IndexIdentity, b: IndexIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function readIndexIdentity(value: JsonValue | undefined): IndexIdentity | undefined {
  if (!jsonObject(value)) return undefined;
  const { dev, ino, size, mtimeNs, ctimeNs } = value;
  if (!jsonText(dev) || !jsonText(ino) || !jsonText(size) || !jsonText(mtimeNs) || !jsonText(ctimeNs)) return undefined;
  const natural = /^(?:0|[1-9]\d*)$/;
  const integer = /^(?:0|-?[1-9]\d*)$/;
  if (!natural.test(dev) || !natural.test(ino) || !natural.test(size) || !integer.test(mtimeNs) || !integer.test(ctimeNs)) return undefined;
  return { dev, ino, size, mtimeNs, ctimeNs };
}

function readTrackedCache(filePath: string, indexPath: string, identity: IndexIdentity): TrackedCacheRead {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "miss" } : { kind: "corrupt" };
  }
  try {
    const parsed: JsonValue = JSON.parse(raw);
    if (!jsonObject(parsed) || !jsonText(parsed.indexPath) || !Array.isArray(parsed.paths) || !parsed.paths.every(jsonText))
      return { kind: "corrupt" };
    if (parsed.version === 1) {
      return Number.isFinite(parsed.mtimeMs) && jsonCounter(parsed.size) !== undefined ? { kind: "miss" } : { kind: "corrupt" };
    }
    if (parsed.version !== 2 || parsed.dependency !== "none") return { kind: "corrupt" };
    const storedIdentity = readIndexIdentity(parsed.identity);
    if (!storedIdentity) return { kind: "corrupt" };
    if (parsed.indexPath !== indexPath || !sameIndexIdentity(storedIdentity, identity)) return { kind: "miss" };
    return { kind: "hit", paths: parsed.paths.map((p) => p.replace(/\\/g, "/")) };
  } catch {
    return { kind: "corrupt" };
  }
}

function writeTrackedCache(filePath: string, data: TrackedCacheFile): void {
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let ownedTemp = false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(tmp, "wx", 0o600);
    ownedTemp = true;
    try {
      fs.writeFileSync(fd, JSON.stringify(data));
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
    ownedTemp = false;
  } catch {
    // The fresh observation remains usable even when its disposable cache fails.
  } finally {
    if (ownedTemp) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort cleanup of our private temp */
      }
    }
  }
}
