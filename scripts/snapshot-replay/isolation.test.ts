/**
 * The auditor's negative controls.
 *
 * A safety proof that only ever reports "clean" proves nothing, so these cases
 * feed it the violations it exists to catch: a read of a forbidden path, a write
 * outside the sandbox, and — the one a naive parser misses — a mutating rename
 * addressed through a directory descriptor rather than an absolute path.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditStraceLog, type AuditProfile } from "./isolation.js";

const SANDBOX = "/var/tmp/sandbox";
const profile: AuditProfile = {
  cwd: `${SANDBOX}/ws`,
  writableRoots: [SANDBOX],
  forbidden: ["/home/user/.rbox", "/home/user/Work/.rbox"],
  readableRoots: ["/repo", "/usr"],
};

function audit(lines: readonly string[]): ReturnType<typeof auditStraceLog> {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "strace-audit-")), "log");
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return auditStraceLog(file, profile);
}

test("a run confined to the sandbox is clean", () => {
  const result = audit([
    `100 openat(AT_FDCWD, "${SANDBOX}/ws/.rbox/state.json", O_RDONLY|O_NOFOLLOW) = 3<${SANDBOX}/ws/.rbox/state.json>`,
    `100 openat(AT_FDCWD, "${SANDBOX}/ws/.rbox/state/state.db", O_RDWR|O_CREAT, 0600) = 4`,
    '100 openat(AT_FDCWD, "/repo/src/cli/index.ts", O_RDONLY|O_CLOEXEC) = 5',
    '100 <... openat resumed>)               = -1 ENOENT (No such file or directory)',
    '100 +++ exited with 0 +++',
  ]);
  expect(result.clean).toBe(true);
  expect(result.unresolved).toEqual([]);
  expect(result.events).toBeGreaterThan(0);
});

test("naming a forbidden path is a violation even when the syscall fails", () => {
  const result = audit([
    '100 openat(AT_FDCWD, "/home/user/.rbox/credentials.json", O_RDONLY) = -1 ENOENT (No such file or directory)',
  ]);
  expect(result.clean).toBe(false);
  expect(result.forbiddenHits).toHaveLength(1);
  expect(result.forbiddenHits[0]?.path).toBe("/home/user/.rbox/credentials.json");
  // Failed, so it changed nothing — the finding is that it was named at all.
  expect(result.foreignMutations).toHaveLength(0);
});

test("a write outside the sandbox is a foreign mutation", () => {
  const result = audit([
    '100 openat(AT_FDCWD, "/home/user/Work/notes.txt", O_WRONLY|O_CREAT|O_TRUNC, 0644) = 6',
  ]);
  expect(result.clean).toBe(false);
  expect(result.foreignMutations.map((event) => event.path)).toEqual(["/home/user/Work/notes.txt"]);
});

test("a dirfd-relative rename outside the sandbox is resolved and caught", () => {
  const result = audit([
    '100 renameat(7</home/user/Work>, "tmp.1234", 7</home/user/Work>, "state.json") = 0',
  ]);
  expect(result.clean).toBe(false);
  expect(result.foreignMutations.map((event) => event.path))
    .toEqual(["/home/user/Work/tmp.1234", "/home/user/Work/state.json"]);
});

test("an AT_FDCWD-relative write resolves against the child's working directory", () => {
  const result = audit(['100 openat(AT_FDCWD, "scratch.tmp", O_WRONLY|O_CREAT, 0600) = 8']);
  expect(result.clean).toBe(true);
  expect(result.unresolved).toEqual([]);
});

test("execve argv is not mistaken for paths", () => {
  const result = audit([
    `100 execve("/usr/bin/bun", ["bun", "replay.ts", "--sandbox", "${SANDBOX}"], 0x7ffd /* 12 vars */) = 0`,
  ]);
  expect(result.unresolved).toEqual([]);
  expect(result.clean).toBe(true);
});
