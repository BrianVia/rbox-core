/**
 * The isolation proof: audit a child's strace log for every path it named.
 *
 * Env-var isolation is a claim about code (`RBOX_HOME`/`HOME` override every
 * global-state root, and the state plane derives all of its paths from the
 * workspace root it is handed). This module is the evidence for that claim on
 * the run that actually happened: every path-taking syscall the child made,
 * bucketed by root, with the mutating ones separated from the reads.
 *
 * Two profiles, because the two children have different rights. The snapshot
 * child must be able to READ the real workspace and must not write to it; the
 * replay child must not name the real state plane at all.
 *
 * The trace is taken with `-y`, so every descriptor argument carries its path
 * and a `dirfd`-relative filename can be resolved to an absolute one instead of
 * being counted as unknown. That matters: Bun's atomic writes rename through a
 * directory descriptor, so a parser that only understood absolute strings would
 * be blind to exactly the mutating calls this audit exists to find.
 */
import fs from "node:fs";
import path from "node:path";

/** strace `%file` covers more syscalls than these, but these are the ones that
 * change the filesystem. `open`/`openat` are decided by their flags. */
const MUTATORS = new Set([
  "creat", "mkdir", "mkdirat", "rmdir", "unlink", "unlinkat", "rename", "renameat", "renameat2",
  "link", "linkat", "symlink", "symlinkat", "truncate", "chmod", "fchmodat", "chown", "lchown",
  "fchownat", "utimensat", "utimes", "mknod", "mknodat", "setxattr", "lsetxattr", "removexattr",
  "mount", "umount2",
]);
const WRITE_FLAGS = /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/;

export interface PathEvent {
  readonly syscall: string;
  readonly path: string;
  readonly mutating: boolean;
}

export interface AuditProfile {
  /** The child's working directory, for resolving `AT_FDCWD`-relative names. */
  readonly cwd: string;
  /** Mutation is allowed only under these prefixes. */
  readonly writableRoots: readonly string[];
  /** Paths that must not be named at all, for any reason — including by a
   * syscall that failed. Naming one is the violation. */
  readonly forbidden: readonly string[];
  /** Reads outside the sandbox that are expected and named, so the report can
   * distinguish "the checkout and the system" from a surprise. */
  readonly readableRoots: readonly string[];
}

export interface AuditResult {
  readonly lines: number;
  readonly events: number;
  /** Relative names with no resolvable descriptor path. A clean proof has none;
   * any survivor is listed so it can be judged rather than assumed harmless. */
  readonly unresolved: readonly string[];
  readonly forbiddenHits: readonly PathEvent[];
  readonly foreignMutations: readonly PathEvent[];
  /** Distinct paths outside every declared root, so "it touched nothing
   * unexpected" is a list a reader can check rather than a boolean. */
  readonly unexpectedPaths: readonly string[];
  readonly clean: boolean;
}

const under = (value: string, root: string): boolean =>
  value === root || value.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * Reaching a declared root means walking to it: the kernel resolves, and Bun's
 * module resolver probes, every directory above it. So an ancestor of a
 * declared root is expected, and so is a READ of a file sitting in one — that
 * is the `package.json`/`tsconfig.json`/`node_modules` walk-up, which mostly
 * returns ENOENT. Neither relaxation touches the forbidden list or the mutation
 * rule, which are what actually keep the host safe.
 */
function expected(event: PathEvent, roots: readonly string[]): boolean {
  if (roots.some((root) => under(event.path, root))) return true;
  const probe = event.mutating ? event.path : path.dirname(event.path);
  return roots.some((root) => under(root, probe));
}

export function auditStraceLog(file: string, profile: AuditProfile): AuditResult {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
  const events: PathEvent[] = [];
  const unresolved = new Set<string>();
  for (const line of lines) {
    const call = /^(?:\d+\s+)?([a-z_0-9]+)\((.*)$/.exec(line);
    if (!call) continue; // `<... resumed>` tails, signal notices, exit notices: no path.
    const [, syscall = "", args = ""] = call;
    // A syscall that returned -1 changed nothing; it still counts as having
    // NAMED its path, which is what the forbidden check is about.
    const failed = /=\s-1\s/.test(args);
    const mutating = !failed
      && (MUTATORS.has(syscall) || ((syscall === "open" || syscall === "openat") && WRITE_FLAGS.test(args)));
    // `-y` renders descriptors as `4</abs/dir>`; the first one in the argument
    // list is the directory a relative name is resolved against.
    const base = /\d+<([^>]+)>/.exec(args)?.[1];
    // `execve`'s argv and envp are quoted strings that are not paths; only its
    // first argument names a file.
    const quoted = [...args.matchAll(/"((?:[^"\\]|\\.)*)"/g)];
    for (const match of syscall === "execve" ? quoted.slice(0, 1) : quoted) {
      const value = match[1] ?? "";
      if (value.length === 0) continue;
      if (value.startsWith("/")) events.push({ syscall, path: value, mutating });
      else if (/AT_FDCWD/.test(args)) events.push({ syscall, path: path.resolve(profile.cwd, value), mutating });
      else if (base !== undefined) events.push({ syscall, path: path.resolve(base, value), mutating });
      else unresolved.add(`${syscall}:${value}`);
    }
  }

  const forbiddenHits = events.filter((event) => profile.forbidden.some((root) => under(event.path, root)));
  const foreignMutations = events.filter((event) =>
    event.mutating && !profile.writableRoots.some((root) => under(event.path, root)));
  const declared = [...profile.writableRoots, ...profile.readableRoots];
  const unexpectedPaths = new Set<string>();
  for (const event of events) {
    if (!expected(event, declared)) unexpectedPaths.add(event.path);
  }
  return {
    lines: lines.length,
    events: events.length,
    unresolved: [...unresolved].slice(0, 20),
    forbiddenHits: forbiddenHits.slice(0, 20),
    foreignMutations: foreignMutations.slice(0, 20),
    unexpectedPaths: [...unexpectedPaths].slice(0, 40),
    clean: forbiddenHits.length === 0 && foreignMutations.length === 0 && unexpectedPaths.size === 0,
  };
}
