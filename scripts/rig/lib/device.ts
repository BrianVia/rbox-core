/**
 * A `Device` is a handle to one running guest (`rig-dev-a`/`-b`). Everything a
 * scenario does to a device — run the rbox CLI, read/write a file, seed a corpus —
 * goes through here, built entirely on container.ts (no direct spawns).
 *
 * The rbox CLI inside a guest is `bun /app/src/cli/index.ts <args>` with
 * `RBOX_API` pointing at the resolved dev URL, so module resolution walks up to
 * the image's linux node_modules and the CLI can never reach prod (config.ts
 * already refused any prod URL before this device existed).
 */
import { exec, type RunResult } from "./container.js";
import { GUEST } from "./config.js";

export interface RboxOpts {
  env?: Record<string, string>;
  cwd?: string;
  /** Don't throw on a nonzero rbox exit — caller inspects the result. */
  allowFail?: boolean;
  /** Secret substrings to mask in any logged/thrown argv. */
  redact?: string[];
}

export class Device {
  constructor(
    readonly name: string,
    private readonly apiUrl: string
  ) {}

  /** Raw command in the guest. */
  async exec(cmd: string[], opts: RboxOpts & { stdin?: string } = {}): Promise<RunResult> {
    return exec({ name: this.name, cmd, env: opts.env, cwd: opts.cwd, stdin: opts.stdin, allowFail: opts.allowFail, redact: opts.redact });
  }

  /** `bun /app/src/cli/index.ts <args>` with RBOX_API injected. */
  async rbox(args: string[], opts: RboxOpts = {}): Promise<RunResult> {
    return exec({
      name: this.name,
      cmd: ["bun", GUEST.cliEntry, ...args],
      env: { RBOX_API: this.apiUrl, ...opts.env },
      cwd: opts.cwd,
      allowFail: opts.allowFail,
      redact: opts.redact,
    });
  }

  /**
   * Run the rbox CLI through a shell so a secret can be passed by ENV EXPANSION
   * rather than argv — the secret reaches the CLI as `--flag "$VAR"` without ever
   * being a literal argument the rig assembles or logs. `env` carries the secret;
   * `redact` masks it in the rig's own error rendering.
   */
  async rboxShell(script: string, opts: RboxOpts = {}): Promise<RunResult> {
    return exec({
      name: this.name,
      cmd: ["sh", "-c", script],
      env: { RBOX_API: this.apiUrl, ...opts.env },
      cwd: opts.cwd,
      allowFail: opts.allowFail,
      redact: opts.redact,
    });
  }

  async mkdirp(dir: string): Promise<void> {
    await this.exec(["mkdir", "-p", dir]);
  }

  async readFile(path: string): Promise<string> {
    return (await this.exec(["cat", path])).stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    // Write via stdin so arbitrary content never rides the argv.
    await this.exec(["sh", "-c", `cat > "${path}"`], { stdin: content });
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.exec(["ln", "-s", target, linkPath]);
  }

  /**
   * Seed a deterministic corpus into `dir` using the in-repo generator
   * (`scripts/bench/corpus.ts`, stdlib-only → runs unchanged in the guest). Same
   * (shape, seed) → byte-identical tree; the shape deliberately includes empty and
   * duplicate-content files (design 56 §9 regression shapes).
   */
  async seedCorpus(dir: string, shape: string, seed: number): Promise<void> {
    await this.mkdirp(dir);
    await this.exec(["bun", GUEST.corpusEntry, dir, shape, String(seed)]);
  }
}
