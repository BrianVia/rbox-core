// Minimal ambient declaration for the subset of the Bun runtime API the rig uses.
// The repo installs no `@types/bun` (src only touches `Bun.*` inside *.test.ts,
// which tsc excludes), so we declare exactly what container.ts needs — nothing
// more — to keep `tsc --noEmit` honest without a new dependency. At runtime Bun
// provides the real implementation; this file only exists for the type-checker.
declare namespace Bun {
  type Stdio = "pipe" | "inherit" | "ignore";
  interface SpawnOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin?: Stdio | Uint8Array;
    stdout?: Stdio;
    stderr?: Stdio;
  }
  interface Subprocess {
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    readonly exited: Promise<number>;
    readonly exitCode: number | null;
    kill(signal?: number | string): void;
  }
  function spawn(cmd: string[], options?: SpawnOptions): Subprocess;
}
