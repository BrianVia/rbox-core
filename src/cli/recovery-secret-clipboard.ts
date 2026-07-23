import { spawn, type SpawnOptions } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_SECRET_BYTES = 4_096;

export type RecoveryClipboardFailure =
  | "unsupported-platform"
  | "input-too-large"
  | "spawn-failed"
  | "write-failed"
  | "timeout"
  | "nonzero-exit";

export type RecoveryClipboardResult =
  | { ok: true; command: string }
  | { ok: false; reason: RecoveryClipboardFailure };

export interface RecoveryClipboardStdin {
  once(event: "error", listener: (error: unknown) => void): unknown;
  end(chunk: Uint8Array, callback: () => void): unknown;
}

export interface RecoveryClipboardChild {
  stdin: RecoveryClipboardStdin | null;
  once(event: "error", listener: (error: unknown) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type RecoveryClipboardSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => RecoveryClipboardChild;

export interface RecoveryClipboardDeps {
  platform?: NodeJS.Platform;
  spawn?: RecoveryClipboardSpawner;
  timeoutMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type ClipboardCommand = readonly [command: string, args: readonly string[]];

const realSpawner: RecoveryClipboardSpawner = (command, args, options) =>
  spawn(command, [...args], options) as unknown as RecoveryClipboardChild;

function commandsFor(platform: NodeJS.Platform): ClipboardCommand[] {
  if (platform === "darwin") return [["pbcopy", []]];
  if (platform === "win32") return [["clip", []]];
  if (platform === "linux") {
    return [
      ["xclip", ["-selection", "clipboard"]],
      ["xsel", ["--clipboard", "--input"]],
    ];
  }
  return [];
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new Error("recovery clipboard timeout must be an integer from 1 to 60000 ms");
  }
  return value;
}

async function runClipboardChild(
  command: ClipboardCommand,
  payload: Buffer,
  deps: Required<Pick<RecoveryClipboardDeps, "spawn" | "setTimer" | "clearTimer">> & { timeoutMs: number }
): Promise<RecoveryClipboardResult> {
  let child: RecoveryClipboardChild;
  try {
    child = deps.spawn(command[0], command[1], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
  } catch {
    return { ok: false, reason: "spawn-failed" };
  }

  const stdin = child.stdin;
  if (!stdin) {
    try { child.kill("SIGKILL"); } catch {}
    return { ok: false, reason: "write-failed" };
  }

  return new Promise((resolve) => {
    let settled = false;
    let writeComplete = false;
    let closeCode: number | null | undefined;
    let closeSignal: NodeJS.Signals | null | undefined;

    const finish = (result: RecoveryClipboardResult): void => {
      if (settled) return;
      settled = true;
      deps.clearTimer(timer);
      resolve(result);
    };
    const maybeFinishSuccess = (): void => {
      if (!writeComplete || closeCode === undefined) return;
      if (closeCode === 0 && closeSignal === null) finish({ ok: true, command: command[0] });
      else finish({ ok: false, reason: "nonzero-exit" });
    };
    const timer = deps.setTimer(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish({ ok: false, reason: "timeout" });
    }, deps.timeoutMs);

    child.once("error", () => finish({ ok: false, reason: "spawn-failed" }));
    child.once("close", (code, signal) => {
      closeCode = code;
      closeSignal = signal;
      maybeFinishSuccess();
    });
    stdin.once("error", () => {
      try { child.kill("SIGKILL"); } catch {}
      finish({ ok: false, reason: "write-failed" });
    });

    try {
      stdin.end(payload, () => {
        writeComplete = true;
        maybeFinishSuccess();
      });
    } catch {
      try { child.kill("SIGKILL"); } catch {}
      finish({ ok: false, reason: "write-failed" });
    }
  });
}

async function writeClipboard(
  value: string | Uint8Array,
  deps: RecoveryClipboardDeps = {}
): Promise<RecoveryClipboardResult> {
  const payload = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  try {
    if (payload.byteLength > MAX_SECRET_BYTES) return { ok: false, reason: "input-too-large" };
    const commands = commandsFor(deps.platform ?? process.platform);
    if (commands.length === 0) return { ok: false, reason: "unsupported-platform" };
    const childDeps = {
      spawn: deps.spawn ?? realSpawner,
      timeoutMs: boundedTimeout(deps.timeoutMs),
      setTimer: deps.setTimer ?? setTimeout,
      clearTimer: deps.clearTimer ?? clearTimeout,
    };
    let last: RecoveryClipboardResult = { ok: false, reason: "spawn-failed" };
    for (const command of commands) {
      last = await runClipboardChild(command, payload, childDeps);
      if (last.ok) return last;
    }
    return last;
  } finally {
    payload.fill(0);
  }
}

/** Copy a recovery phrase through stdin and report success only after the
 * clipboard utility accepts the full payload and exits zero. No child output or
 * raw error is exposed. The caller-owned string/bytes are not mutated; every
 * mutable internal payload copy is wiped on all exits. */
export function copyRecoverySecretToClipboard(
  secret: string | Uint8Array,
  deps: RecoveryClipboardDeps = {}
): Promise<RecoveryClipboardResult> {
  return writeClipboard(secret, deps);
}

/** Replace the current clipboard contents with an empty payload, using the same
 * bounded zero-exit contract as recovery-secret copy. */
export function clearRecoverySecretClipboard(
  deps: RecoveryClipboardDeps = {}
): Promise<RecoveryClipboardResult> {
  return writeClipboard(new Uint8Array(), deps);
}
