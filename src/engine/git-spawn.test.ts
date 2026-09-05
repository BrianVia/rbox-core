import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { git, gitRaw } from "./git-spawn.js";

const exec = promisify(execFile);
const roots: string[] = [];
const REMOVED = [
  "GIT_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR",
  "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE",
  "GIT_REPLACE_REF_BASE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_IMPLICIT_WORK_TREE", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM", "GIT_EXTERNAL_DIFF", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER",
  "GIT_NO_LAZY_FETCH", "GIT_NO_REPLACE_OBJECTS", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
] as const;
const PRESERVED = [
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSL_NO_VERIFY",
  "GIT_ASKPASS", "GIT_TERMINAL_PROMPT", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_TRACE",
  "GIT_TRACE_PACKET", "GIT_CURL_VERBOSE", "GIT_HTTP_LOW_SPEED_LIMIT", "GIT_PROXY_COMMAND",
  "GIT_LFS_SKIP_SMUDGE", "GIT_CONFIG_NOSYSTEM",
] as const;

async function tempDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-git-env-"));
  roots.push(root);
  return root;
}

function parseEnv(stdout: string): Map<string, string> {
  return new Map(stdout.trim().split("\n").map((line) => {
    const equals = line.indexOf("=");
    return [line.slice(0, equals), line.slice(equals + 1)];
  }));
}

async function withAmbient(values: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const saved = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function rawGit(root: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await exec("git", ["-C", root, ...args], {
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_OBJECT_DIRECTORY: undefined,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
      GIT_NAMESPACE: undefined,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "rbox test",
      GIT_AUTHOR_EMAIL: "rbox-test@local",
      GIT_COMMITTER_NAME: "rbox test",
      GIT_COMMITTER_EMAIL: "rbox-test@local",
      ...env,
    },
  });
  return result.stdout.toString().trim();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("Git children strip ambient routing and config injection while preserving integrations and owned overrides", async () => {
  const bin = await tempDir();
  await fs.writeFile(path.join(bin, "git"), "#!/bin/sh\n/usr/bin/env\n");
  await fs.chmod(path.join(bin, "git"), 0o755);
  const poisoned = Object.fromEntries([...REMOVED, ...PRESERVED].map((name) => [name, `ambient:${name}`]));

  await withAmbient(poisoned, async () => {
    const inherited = parseEnv(await gitRaw(".", ["env"], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    }));
    for (const name of REMOVED) expect(inherited.has(name)).toBe(false);
    for (const name of PRESERVED) expect(inherited.get(name)).toBe(`ambient:${name}`);

    const owned = parseEnv(await gitRaw(".", ["env"], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GIT_DIR: "owned:dir",
        GIT_INDEX_FILE: "owned:index",
        GIT_NO_LAZY_FETCH: "owned:lazy",
        GIT_NO_REPLACE_OBJECTS: "owned:replace",
      },
    }));
    expect(owned.get("GIT_DIR")).toBe("owned:dir");
    expect(owned.get("GIT_INDEX_FILE")).toBe("owned:index");
    expect(owned.get("GIT_NO_LAZY_FETCH")).toBe("owned:lazy");
    expect(owned.get("GIT_NO_REPLACE_OBJECTS")).toBe("owned:replace");
  });
});

test("runner ignores ambient alternate objects and namespace", async () => {
  const repo = await tempDir();
  const foreign = await tempDir();
  await rawGit(repo, ["init", "-q", "-b", "main"]);
  await rawGit(repo, ["commit", "--allow-empty", "-qm", "local"]);
  await rawGit(foreign, ["init", "-q", "-b", "main"]);
  await rawGit(foreign, ["commit", "--allow-empty", "-qm", "foreign"]);
  const oid = await rawGit(foreign, ["rev-parse", "HEAD"]);
  const alternates = path.join(foreign, ".git", "objects");
  await rawGit(repo, ["cat-file", "-e", oid], { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates });

  await withAmbient({ GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates, GIT_NAMESPACE: "foo" }, async () => {
    await expect(git(repo, ["cat-file", "-e", oid])).rejects.toThrow();
    expect((await git(repo, ["for-each-ref", "--format=%(refname)"])).split("\n")).toContain("refs/heads/main");
  });
});
