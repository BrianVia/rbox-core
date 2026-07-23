/**
 * The only interactive-prompt seam in rbox.
 *
 * The facade stays dependency-light and imports Ink/React only after the
 * interaction policy and both terminal streams pass the TTY gate. Callers own
 * workflow decisions; this module owns terminal lifecycle and prompt widgets.
 */
import path from "node:path";
import {
  expandUserPath,
  UnsupportedPathError,
} from "./directory-picker.js";
import { currentInteractionPolicy } from "./prompt-policy.js";
import type {
  CheckboxPrompt,
  CheckboxPromptConfig,
  ConfirmPromptConfig,
  InputPromptConfig,
  KeypressPromptConfig,
  LoginFallbackAnswer,
  LoginFallbackPromptConfig,
  PasswordPromptConfig,
  SearchPromptConfig,
  SelectPromptConfig,
} from "./prompt-types.js";

export { expandUserPath, UnsupportedPathError } from "./directory-picker.js";
export type {
  CheckboxPrompt,
  CheckboxPromptConfig,
  ConfirmPromptConfig,
  InputPromptConfig,
  LoginFallbackAnswer,
  LoginFallbackPromptConfig,
  PasswordPromptConfig,
  PromptChoice,
  SearchPromptConfig,
  SelectPromptConfig,
} from "./prompt-types.js";

const CANCEL_EXIT = 130;

export class PromptUnavailableError extends Error {
  constructor() {
    super("interactive prompt unavailable — run this command in a terminal without redirecting stderr");
    this.name = "PromptUnavailableError";
  }
}

type InkRuntime = typeof import("./prompt-ink.js");
let runtimePromise: Promise<InkRuntime> | undefined;

function runtime(): Promise<InkRuntime> {
  return runtimePromise ??= import("./prompt-ink.js");
}

/** Interactive widgets require readable input and a visible prompt surface. */
export function isInteractive(): boolean {
  return currentInteractionPolicy().enabled
    && process.stdin.isTTY === true
    && process.stderr.isTTY === true;
}

function requireInteractive(): void {
  if (!isInteractive()) throw new PromptUnavailableError();
}

async function run<T>(invoke: (loaded: InkRuntime) => Promise<T>, exit: (code: number) => never = process.exit): Promise<T> {
  requireInteractive();
  const loaded = await runtime();
  try {
    return await invoke(loaded);
  } catch (error) {
    if (error instanceof loaded.PromptCancelledError) return exit(CANCEL_EXIT);
    throw error;
  }
}

export const promptSelect = <V>(config: SelectPromptConfig<V>): Promise<V> =>
  run((loaded) => loaded.inkSelect(config));

export const promptSearch = <V>(config: SearchPromptConfig<V>): Promise<V> =>
  run((loaded) => loaded.inkSearch(config));

export const promptInput = (config: InputPromptConfig): Promise<string> =>
  run((loaded) => loaded.inkInput(config));

export const promptConfirm = (config: ConfirmPromptConfig): Promise<boolean> =>
  run((loaded) => loaded.inkConfirm(config));

/** Pairing/bootstrap bearer values are never echoed or represented by length. */
export const promptPassword = (config: PasswordPromptConfig): Promise<string> =>
  run((loaded) => loaded.inkPassword(config));

/** Design-189's one-mount fallback ladder. A blank or locally malformed token
 * replaces the masked editor with visible recovery-phrase entry in-place. */
export const promptLoginFallback = (
  config: LoginFallbackPromptConfig,
): Promise<LoginFallbackAnswer> =>
  run((loaded) => loaded.inkLoginFallback(config));

export const promptCheckbox: CheckboxPrompt = <V>(config: CheckboxPromptConfig<V>): Promise<V[]> =>
  run((loaded) => loaded.inkCheckbox(config));

/** Test/embedding factory. Production uses the shared lazy Ink runtime. */
export function createCheckboxPrompt(deps: {
  output?: NodeJS.WritableStream;
  invoke?: <V>(config: CheckboxPromptConfig<V>, context: { output: NodeJS.WritableStream }) => Promise<V[]>;
  exit?: (code: number) => never;
  isExitPromptError?: (error: unknown) => boolean;
} = {}): CheckboxPrompt {
  if (!deps.invoke) return promptCheckbox;
  const output = deps.output ?? process.stderr;
  const exit = deps.exit ?? process.exit;
  return async <V>(config: CheckboxPromptConfig<V>): Promise<V[]> => {
    try {
      return await deps.invoke!(config, { output });
    } catch (error) {
      if (deps.isExitPromptError?.(error)) return exit(CANCEL_EXIT);
      throw error;
    }
  };
}

export async function promptKeypress(config: KeypressPromptConfig = {}): Promise<string | undefined> {
  if (!isInteractive() || config.signal?.aborted) return undefined;
  return run((loaded) => loaded.inkKeypress(config));
}

/** Test-only real renderer seam used by the directory keymap contract. */
export async function directoryPickerPrompt(
  config: import("./directory-picker.js").DirectoryPickerOptions,
  streams: { input: NodeJS.ReadStream; output: NodeJS.WriteStream },
): Promise<string> {
  const input = streams.input as NodeJS.ReadStream & {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => unknown;
    ref?: () => unknown;
    unref?: () => unknown;
  };
  const output = streams.output as NodeJS.WriteStream & { isTTY?: boolean; columns?: number; rows?: number };
  input.isTTY ??= true;
  input.isRaw ??= false;
  input.setRawMode ??= (mode) => { input.isRaw = mode; return input; };
  input.ref ??= () => input;
  input.unref ??= () => input;
  output.isTTY ??= true;
  output.columns ??= 80;
  output.rows ??= 24;
  const loaded = await runtime();
  return loaded.inkDirectoryWithStreams(config, { input, output });
}

type PromptInput = typeof promptInput;

/** Prompt for an interactive path, resolving it against the caller's cwd. */
export async function promptPath(opts: {
  message: string;
  default?: string;
  cwd: string;
  /** Test/embedding seams force the plain validation loop. */
  input?: PromptInput;
  writeStderr?: (text: string) => void;
}): Promise<string> {
  if (opts.input === undefined && isInteractive()) {
    return run((loaded) => loaded.inkDirectory({
      message: opts.message,
      cwd: opts.cwd,
      ...(opts.default !== undefined ? { default: opts.default } : {}),
    }));
  }

  const ask = opts.input ?? promptInput;
  const writeStderr = opts.writeStderr ?? ((text: string) => process.stderr.write(text));
  for (;;) {
    const raw = (await ask({
      message: opts.message,
      ...(opts.default !== undefined ? { default: opts.default } : {}),
    })).trim();
    try {
      return path.resolve(opts.cwd, expandUserPath(raw));
    } catch (error) {
      if (!(error instanceof UnsupportedPathError)) throw error;
      writeStderr(`${error.message}\n`);
    }
  }
}
