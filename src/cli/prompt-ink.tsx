import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useInput, usePaste, type Instance, type Key } from "ink";
import {
  DIRECTORY_PICKER_PAGE_SIZE,
  DirectoryListingCache,
  highlightedAnswer,
  projectDirectoryPicker,
  tabRewrite,
} from "./directory-picker.js";
import type {
  CheckboxPromptConfig,
  ConfirmPromptConfig,
  DirectoryPromptConfig,
  InputPromptConfig,
  KeypressPromptConfig,
  PasswordPromptConfig,
  PromptChoice,
  PromptValidation,
  SearchPromptConfig,
  SelectPromptConfig,
} from "./prompt-types.js";
import { PassThrough } from "node:stream";
import { ensureCursorVisible, stderrStyle } from "./style.js";
import { markInkRuntimeLoaded } from "./prompt-runtime-sentinel.js";

markInkRuntimeLoaded();

export class PromptCancelledError extends Error {
  constructor() {
    super("prompt cancelled");
    this.name = "PromptCancelledError";
  }
}

type Submit<T> = (value: T, answer: string) => void;
type Fail = (error: unknown) => void;
export interface PromptStreams {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

const PAGE_SIZE = 7;

function label<V>(choice: PromptChoice<V>): string {
  return choice.name ?? String(choice.value);
}

function enabled<V>(choice: PromptChoice<V>): boolean {
  return choice.disabled !== true && typeof choice.disabled !== "string";
}

function firstEnabled<V>(choices: readonly PromptChoice<V>[], requested?: V): number {
  if (requested !== undefined) {
    const found = choices.findIndex((choice) => enabled(choice) && Object.is(choice.value, requested));
    if (found >= 0) return found;
  }
  const found = choices.findIndex(enabled);
  return Math.max(0, found);
}

function move<V>(choices: readonly PromptChoice<V>[], current: number, delta: number, loop = true): number {
  if (choices.length === 0) return 0;
  for (let step = 1; step <= choices.length; step++) {
    const raw = current + delta * step;
    if (!loop && (raw < 0 || raw >= choices.length)) return current;
    const index = (raw % choices.length + choices.length) % choices.length;
    if (enabled(choices[index]!)) return index;
  }
  return current;
}

function pageWindow(length: number, active: number, pageSize = PAGE_SIZE): [number, number] {
  const size = Math.max(1, pageSize);
  const start = Math.max(0, Math.min(active - Math.floor(size / 2), length - size));
  return [start, Math.min(length, start + size)];
}

function ctrlC(input: string, key: Key): boolean {
  return key.ctrl && input.toLowerCase() === "c";
}

function useCancel(inputHandler: (input: string, key: Key) => void, onCancel: () => void, active = true): void {
  useInput((input, key) => {
    if (ctrlC(input, key)) {
      onCancel();
      return;
    }
    inputHandler(input, key);
  }, { isActive: active });
}

const ESC = "\u001b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const SPLIT_CONTROL = new Set(["\r", "\n", "\t", "\u0003", "\u007f", "\b"]);

/** A slow pty coalesces independent keystrokes into one chunk, and Ink delivers
 * consecutive plain bytes as ONE input token — so a trailing Enter (\r) or
 * Ctrl-C (\x03) vanishes inside a text run and the prompt hangs (or dies by
 * signal). Split a chunk into per-key parts: escape sequences stay whole,
 * bracketed-paste bodies pass through unsplit, and control bytes become their
 * own parts so Ink parses each with correct key flags. */
export function splitKeystrokeChunk(chunk: string, state: { inPaste: boolean }): string[] {
  const parts: string[] = [];
  let plain = "";
  const flushPlain = () => {
    if (plain) {
      parts.push(plain);
      plain = "";
    }
  };
  let index = 0;
  while (index < chunk.length) {
    if (state.inPaste) {
      const end = chunk.indexOf(PASTE_END, index);
      if (end < 0) {
        parts.push(chunk.slice(index));
        index = chunk.length;
      } else {
        parts.push(chunk.slice(index, end + PASTE_END.length));
        state.inPaste = false;
        index = end + PASTE_END.length;
      }
      continue;
    }
    const character = chunk[index]!;
    if (character === ESC) {
      flushPlain();
      if (chunk.startsWith(PASTE_START, index)) {
        state.inPaste = true;
        parts.push(PASTE_START);
        index += PASTE_START.length;
        continue;
      }
      let end = index + 1;
      if (chunk[end] === "[") {
        end++;
        while (end < chunk.length && (chunk.charCodeAt(end) < 0x40 || chunk.charCodeAt(end) > 0x7e)) end++;
        end++;
      } else if (chunk[end] === "O") {
        end += 2;
      } else {
        end += 1;
      }
      end = Math.min(end, chunk.length);
      parts.push(chunk.slice(index, end));
      index = end;
    } else if (SPLIT_CONTROL.has(character)) {
      flushPlain();
      parts.push(character);
      index++;
    } else {
      plain += character;
      index++;
    }
  }
  flushPlain();
  return parts;
}

/** Present Ink a stdin whose chunks are one key each: split parts are re-emitted
 * on separate ticks so React commits state between keystrokes. Raw-mode,
 * ref/unref, and flow control delegate to the real stream. */
function wrapPromptStdin(source: NodeJS.ReadStream & { isRaw?: boolean; setRawMode?: (mode: boolean) => unknown }): {
  wrapped: NodeJS.ReadStream;
  detach: () => void;
} {
  const wrapped = new PassThrough() as unknown as NodeJS.ReadStream & {
    isRaw: boolean;
    setRawMode: (mode: boolean) => unknown;
    write: (chunk: string) => boolean;
  };
  wrapped.isTTY = source.isTTY;
  wrapped.isRaw = source.isRaw ?? false;
  wrapped.setRawMode = (mode: boolean) => {
    source.setRawMode?.(mode);
    wrapped.isRaw = mode;
    return wrapped;
  };
  const basePause = wrapped.pause.bind(wrapped);
  const baseResume = wrapped.resume.bind(wrapped);
  wrapped.pause = () => {
    source.pause();
    return basePause();
  };
  wrapped.resume = () => {
    source.resume();
    return baseResume();
  };
  wrapped.ref = () => {
    source.ref?.();
    return wrapped;
  };
  wrapped.unref = () => {
    source.unref?.();
    return wrapped;
  };
  const state = { inPaste: false };
  const queue: string[] = [];
  let draining = false;
  const drain = () => {
    const next = queue.shift();
    if (next === undefined) {
      draining = false;
      return;
    }
    wrapped.write(next);
    setImmediate(drain);
  };
  const onData = (chunk: Buffer | string) => {
    queue.push(...splitKeystrokeChunk(chunk.toString(), state));
    if (!draining && queue.length > 0) {
      draining = true;
      drain();
    }
  };
  source.on("data", onData);
  return {
    wrapped,
    detach: () => {
      source.removeListener("data", onData);
    },
  };
}

function Frame({ message, inline, children, hint, error }: {
  message: string;
  /** Rendered on the message line itself — typed answers echo inline there,
   * matching the flow assertions that treat "? question answer" as one line. */
  inline?: React.ReactNode;
  children?: React.ReactNode;
  hint?: string;
  error?: string;
}) {
  return (
    <Box flexDirection="column">
      <Text>{stderrStyle.cyan("?")} {message}{inline}</Text>
      {children}
      {error ? <Text>{stderrStyle.red(`  ${error}`)}</Text> : undefined}
      {hint ? <Text>{stderrStyle.dim(`  ${hint}`)}</Text> : undefined}
    </Box>
  );
}

class SafeBoundary extends React.Component<{ fail: Fail; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: unknown): void {
    queueMicrotask(() => this.props.fail(error));
  }
  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function ChoiceRows<V>({ choices, active, pageSize, selected }: {
  choices: readonly PromptChoice<V>[];
  active: number;
  pageSize?: number;
  selected?: ReadonlySet<number>;
}) {
  const [start, end] = pageWindow(choices.length, active, pageSize);
  const visible = choices.slice(start, end);
  return (
    <Box flexDirection="column">
      {visible.map((choice, offset) => {
        const index = start + offset;
        const current = index === active;
        const mark = selected ? (selected.has(index) ? "◉" : "◯") : (current ? "❯" : " ");
        const disabled = !enabled(choice);
        const reason = typeof choice.disabled === "string" ? ` (${choice.disabled})` : "";
        return (
          <Box key={index} flexDirection="column">
            <Text>{disabled
              ? stderrStyle.dim(`  ${mark} ${label(choice)}${reason}`)
              : current
                ? stderrStyle.cyan(`  ${mark} ${label(choice)}${reason}`)
                : `  ${mark} ${label(choice)}${reason}`}</Text>
            {current && choice.description ? <Text>{stderrStyle.dim(`      ${choice.description}`)}</Text> : undefined}
          </Box>
        );
      })}
      {start > 0 ? <Text>{stderrStyle.dim(`  ↑ ${start} more`)}</Text> : undefined}
      {end < choices.length ? <Text>{stderrStyle.dim(`  ↓ ${choices.length - end} more`)}</Text> : undefined}
    </Box>
  );
}

function SelectPrompt<V>({ config, submit, cancel }: {
  config: SelectPromptConfig<V>;
  submit: Submit<V>;
  cancel: () => void;
}) {
  const [active, setActive] = useState(() => firstEnabled(config.choices, config.default));
  useCancel((_input, key) => {
    if (key.upArrow) setActive((index) => move(config.choices, index, -1, config.loop !== false));
    else if (key.downArrow) setActive((index) => move(config.choices, index, 1, config.loop !== false));
    else if (key.return) {
      const choice = config.choices[active];
      if (choice && enabled(choice)) submit(choice.value, choice.short ?? label(choice));
    }
  }, cancel);
  return (
    <Frame message={config.message} hint="↑/↓ move · Enter select">
      <ChoiceRows choices={config.choices} active={active} pageSize={config.pageSize} />
    </Frame>
  );
}

function CheckboxPrompt<V>({ config, submit, fail, cancel }: {
  config: CheckboxPromptConfig<V>;
  submit: Submit<V[]>;
  fail: Fail;
  cancel: () => void;
}) {
  const [active, setActive] = useState(() => firstEnabled(config.choices, config.default));
  const [selected, setSelected] = useState(() => new Set(
    config.choices.flatMap((choice, index) => choice.checked ? [index] : []),
  ));
  const [validation, setValidation] = useState<string>();
  const [pending, setPending] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  useCancel((_input, key) => {
    if (pending) return;
    if (key.upArrow) setActive((index) => move(config.choices, index, -1, config.loop !== false));
    else if (key.downArrow) setActive((index) => move(config.choices, index, 1, config.loop !== false));
    else if (_input === " ") {
      const choice = config.choices[active];
      if (!choice || !enabled(choice)) return;
      setSelected((prior) => {
        const next = new Set(prior);
        if (next.has(active)) next.delete(active);
        else next.add(active);
        return next;
      });
      setValidation(undefined);
    } else if (key.return) {
      const values = config.choices.flatMap((choice, index) => selected.has(index) ? [choice.value] : []);
      setPending(true);
      void Promise.resolve().then(() => config.validate?.(values) ?? true).then((result: PromptValidation) => {
        if (!live.current) return;
        if (result === true) {
          submit(values, `${values.length} selected`);
          return;
        }
        setValidation(typeof result === "string" ? result : "Choose a valid selection");
        setPending(false);
      }, fail);
    }
  }, cancel);

  return (
    <Frame message={config.message} hint={pending ? "validating…" : "↑/↓ move · Space select · Enter continue"} error={validation}>
      <ChoiceRows choices={config.choices} active={active} pageSize={config.pageSize} selected={selected} />
    </Frame>
  );
}

export function editBuffer(value: string, cursor: number, input: string, key: Partial<Key>): { value: string; cursor: number } {
  const characters = Array.from(value);
  if (key.leftArrow) return { value, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { value, cursor: Math.min(characters.length, cursor + 1) };
  if (key.home) return { value, cursor: 0 };
  if (key.end) return { value, cursor: characters.length };
  if (key.backspace) {
    if (cursor === 0) return { value, cursor };
    characters.splice(cursor - 1, 1);
    return { value: characters.join(""), cursor: cursor - 1 };
  }
  if (key.delete) {
    characters.splice(cursor, 1);
    return { value: characters.join(""), cursor };
  }
  const printable = input.replace(/[\r\n\u0000-\u001f\u007f]/g, "");
  if (!printable) return { value, cursor };
  const inserted = Array.from(printable);
  characters.splice(cursor, 0, ...inserted);
  return {
    value: characters.join(""),
    cursor: cursor + inserted.length,
  };
}

function InputPrompt({ config, secret, submit, fail, cancel }: {
  config: InputPromptConfig | PasswordPromptConfig;
  secret: boolean;
  submit: Submit<string>;
  fail: Fail;
  cancel: () => void;
}) {
  const initial = "default" in config ? config.default ?? "" : "";
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [edited, setEdited] = useState(false);
  const [validation, setValidation] = useState<string>();
  const [pending, setPending] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  useCancel((input, key) => {
    if (pending) return;
    if (key.return) {
      const answer = edited ? value : initial;
      setPending(true);
      const validator = "validate" in config ? config.validate : undefined;
      void Promise.resolve().then(() => validator?.(answer) ?? true).then((result) => {
        if (!live.current) return;
        if (result === true) {
          submit(answer, secret ? "received" : answer);
          setValue("");
          setCursor(0);
          return;
        }
        setValidation(typeof result === "string" ? result : "Enter a valid value");
        setPending(false);
      }, fail);
      return;
    }
    const printable = input.replace(/[\r\n\u0000-\u001f\u007f]/g, "");
    const base = !edited && !printable ? initial : value;
    const baseCursor = !edited && !printable ? Array.from(initial).length : cursor;
    const next = editBuffer(base, baseCursor, input, key);
    setValue(next.value);
    setCursor(next.cursor);
    if (printable || next.value !== base || next.cursor !== baseCursor) setEdited(true);
    setValidation(undefined);
  }, cancel);
  usePaste((text) => {
    if (pending) return;
    const next = editBuffer(edited ? value : "", edited ? cursor : 0, text, {});
    setValue(next.value);
    setCursor(next.cursor);
    setEdited(true);
    setValidation(undefined);
  }, { isActive: !pending });

  const visible = Array.from(edited ? value : initial);
  const before = secret ? "" : visible.slice(0, cursor).join("");
  const after = secret ? "" : visible.slice(cursor).join("");
  return (
    <Frame message={config.message} hint={pending ? "validating…" : "Enter submit · Ctrl-C cancel"} error={validation}>
      <Text>{secret ? "  " : "  " + before}<Text inverse> </Text>{after}</Text>
    </Frame>
  );
}

function ConfirmPrompt({ config, submit, cancel }: {
  config: ConfirmPromptConfig;
  submit: Submit<boolean>;
  cancel: () => void;
}) {
  // Inquirer parity: type an answer, Enter submits. A single "n" keystroke must
  // NOT settle the prompt — flows send "n" then "Enter", and a single-key
  // confirm would leak that trailing Enter into whatever prompt mounts next.
  const [value, setValue] = useState("");
  useCancel((input, key) => {
    if (key.return) {
      const answer = value.trim().toLowerCase();
      if (answer === "") {
        if (config.default !== undefined) submit(config.default, config.default ? "Yes" : "No");
        return;
      }
      if (answer.startsWith("y")) submit(true, "Yes");
      else if (answer.startsWith("n")) submit(false, "No");
      else setValue("");
      return;
    }
    if (key.backspace || key.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }
    const printable = input.replace(/[\r\n\u0000-\u001f\u007f]/g, "");
    if (printable) setValue((current) => current + printable);
  }, cancel);
  const suffix = config.default === true ? "(Y/n)" : config.default === false ? "(y/N)" : "(y/n)";
  return <Frame message={`${config.message} ${suffix}`} inline={<> {value}<Text inverse> </Text></>} />;
}

function SearchPrompt<V>({ config, submit, fail, cancel }: {
  config: SearchPromptConfig<V>;
  submit: Submit<V>;
  fail: Fail;
  cancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [choices, setChoices] = useState<readonly PromptChoice<V>[]>([]);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(true);
  const generation = useRef(0);
  const live = useRef(true);

  useEffect(() => {
    const current = ++generation.current;
    setPending(true);
    void Promise.resolve().then(() => config.source(query || undefined)).then((next) => {
      if (!live.current || current !== generation.current) return;
      setChoices(next);
      setActive(firstEnabled(next, config.default));
      setPending(false);
    }, fail);
  }, [query]);
  useEffect(() => () => {
    live.current = false;
    generation.current++;
  }, []);

  useCancel((input, key) => {
    if (key.upArrow) setActive((index) => move(choices, index, -1, config.loop !== false));
    else if (key.downArrow) setActive((index) => move(choices, index, 1, config.loop !== false));
    else if (key.return && !pending) {
      const choice = choices[active];
      if (choice && enabled(choice)) submit(choice.value, choice.short ?? label(choice));
    } else {
      const edited = editBuffer(query, cursor, input, key);
      setQuery(edited.value);
      setCursor(edited.cursor);
    }
  }, cancel);
  usePaste((text) => {
    const edited = editBuffer(query, cursor, text, {});
    setQuery(edited.value);
    setCursor(edited.cursor);
  });

  return (
    <Frame message={config.message} hint={pending ? "searching…" : "Type to filter · ↑/↓ move · Enter select"}>
      <Text>{`  ${query}`}<Text inverse> </Text></Text>
      <ChoiceRows choices={choices} active={active} pageSize={config.pageSize} />
    </Frame>
  );
}

function DirectoryPrompt({ config, submit, cancel }: {
  config: DirectoryPromptConfig;
  submit: Submit<string>;
  cancel: () => void;
}) {
  const [raw, setRaw] = useState("");
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
  const [replaceOnEdit, setReplaceOnEdit] = useState(false);
  const cache = useMemo(() => new DirectoryListingCache(), []);
  const projection = projectDirectoryPicker(raw, config, cache);
  const rows = projection.rows.slice(0, DIRECTORY_PICKER_PAGE_SIZE);

  useCancel((input, key) => {
    if (key.return) {
      const answer = highlightedAnswer(projection, active);
      if (answer !== undefined) submit(answer, answer);
      else if (projection.notice) {
        setReplaceOnEdit(true);
      }
    } else if (key.tab) {
      const rewritten = tabRewrite(projection, config.cwd);
      if (rewritten !== undefined) {
        setRaw(rewritten);
        setCursor(Array.from(rewritten).length);
        setActive(0);
      }
    } else if (key.upArrow) {
      if (rows.length) setActive((index) => (index - 1 + rows.length) % rows.length);
    } else if (key.downArrow) {
      if (rows.length) setActive((index) => (index + 1) % rows.length);
    } else {
      const replace = replaceOnEdit && input.replace(/[\r\n\u0000-\u001f\u007f]/g, "").length > 0;
      const edited = editBuffer(replace ? "" : raw, replace ? 0 : cursor, input, key);
      setRaw(edited.value);
      setCursor(edited.cursor);
      setActive(0);
      setReplaceOnEdit(false);
    }
  }, cancel);
  usePaste((text) => {
    const edited = editBuffer(replaceOnEdit ? "" : raw, replaceOnEdit ? 0 : cursor, text, {});
    setRaw(edited.value);
    setCursor(edited.cursor);
    setActive(0);
    setReplaceOnEdit(false);
  });

  return (
    <Frame
      message={config.message}
      inline={<> {raw}<Text inverse> </Text></>}
      hint="Enter = this directory · type to filter · Tab completes"
    >
      <Box flexDirection="column">
        {rows.map((row, index) => {
          const text = `${index === active ? "  ❯" : "   "} ${row.label}`;
          return <Text key={`${row.kind}:${row.answer}`}>{index === active ? stderrStyle.cyan(text) : text}</Text>;
        })}
        {projection.notice ? <Text>{stderrStyle.dim(`  ${projection.notice}`)}</Text> : undefined}
        {projection.rows.length > rows.length ? <Text>{stderrStyle.dim(`  +${projection.rows.length - rows.length} more`)}</Text> : undefined}
      </Box>
    </Frame>
  );
}

function KeypressPrompt({ submit, cancel }: { submit: Submit<string | undefined>; cancel: () => void }) {
  useCancel((input, key) => {
    if (key.return) submit("return", "return");
    else if (key.escape) submit("escape", "escape");
    else if (key.tab) submit("tab", "tab");
    else if (key.upArrow) submit("up", "up");
    else if (key.downArrow) submit("down", "down");
    else if (input) submit(input, input);
  }, cancel);
  return null;
}

function SecretRenderFailurePrompt({ cancel }: { cancel: () => void }) {
  const [value, setValue] = useState("");
  const [explode, setExplode] = useState(false);
  useCancel((input, key) => {
    if (key.return) {
      setExplode(true);
      return;
    }
    const printable = input.replace(/[\r\n\u0000-\u001f\u007f]/g, "");
    if (printable) setValue((current) => current + printable);
  }, cancel);
  if (explode) throw new Error("synthetic secret render failure");
  void value; // The secret intentionally remains only in component state.
  return (
    <Frame message="TUI selftest: secret render failure" hint="Enter trigger · Ctrl-C cancel">
      <Text>  <Text inverse> </Text></Text>
    </Frame>
  );
}

function Completed({ message, answer, secret = false }: { message: string; answer: string; secret?: boolean }) {
  return <Text>{stderrStyle.sym.ok} {message} {secret ? "received" : answer}</Text>;
}

const activeInputs = new WeakSet<NodeJS.ReadStream>();

async function waitForExit(instance: Instance | undefined): Promise<void> {
  if (!instance) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      instance.waitUntilExit(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 100); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mountPrompt<T>(args: {
  message: string;
  secret?: boolean;
  signal?: AbortSignal;
  stdin?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  component: (handlers: { submit: Submit<T>; fail: Fail; cancel: () => void }) => React.ReactNode;
}): Promise<T> {
  if (args.signal?.aborted) throw new DOMException("prompt aborted", "AbortError");
  const source = (args.stdin ?? process.stdin) as NodeJS.ReadStream & { isRaw?: boolean; setRawMode?: (mode: boolean) => unknown };
  if (activeInputs.has(source)) throw new Error("another interactive prompt is already active on this terminal");
  activeInputs.add(source);
  const output = args.output ?? process.stderr;
  const wasRaw = source.isRaw ?? false;
  const wasPaused = source.isPaused();
  const { wrapped: stdin, detach } = wrapPromptStdin(source);
  let instance: Instance | undefined;
  let settled = false;
  let abort: (() => void) | undefined;
  let restored = false;

  const restoreTerminal = () => {
    if (restored) return;
    restored = true;
    process.removeListener("SIGINT", onSigint);
    detach();
    source.setRawMode?.(wasRaw);
    if (wasPaused) source.pause();
    else source.resume();
    ensureCursorVisible(output);
    activeInputs.delete(source);
  };

  // Ctrl-C between mount and Ink's raw-mode/input attach arrives as a real
  // SIGINT (raw mode is not on yet, so the tty driver signals us). Restore the
  // terminal and exit 130 SYNCHRONOUSLY: Ink's signal-exit dependency re-raises
  // the signal right after our listener returns, so an async cancel path would
  // lose the race and die by default signal disposition (which some tmux/CI
  // environments then report as status 0). Once raw mode is active, Ctrl-C
  // arrives through useInput instead and this listener stays inert.
  const onSigint = () => {
    restoreTerminal();
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  try {
    return await new Promise<T>((resolve, reject) => {
      const settle = (outcome: { kind: "value"; value: T; answer: string } | { kind: "error"; error: unknown } | { kind: "cancel" }) => {
        if (settled) return;
        settled = true;
        void (async () => {
          try {
            args.signal?.removeEventListener("abort", abort!);
            if (outcome.kind === "value") {
              instance?.rerender(<Completed message={args.message} answer={outcome.answer} secret={args.secret} />);
              await instance?.waitUntilRenderFlush();
            } else {
              await instance?.waitUntilRenderFlush();
            }
            instance?.unmount();
            await waitForExit(instance);
          } catch (cleanupError) {
            if (outcome.kind === "value") {
              reject(cleanupError);
              return;
            }
          } finally {
            restoreTerminal();
          }
          if (outcome.kind === "value") resolve(outcome.value);
          else if (outcome.kind === "cancel") reject(new PromptCancelledError());
          else reject(outcome.error);
        })();
      };

      abort = () => settle({ kind: "error", error: new DOMException("prompt aborted", "AbortError") });
      args.signal?.addEventListener("abort", abort, { once: true });
      const handlers: { submit: Submit<T>; fail: Fail; cancel: () => void } = {
        submit: (value, answer) => settle({ kind: "value", value, answer }),
        fail: (error) => settle({ kind: "error", error }),
        cancel: () => settle({ kind: "cancel" }),
      };
      try {
        instance = render(<SafeBoundary fail={handlers.fail}>{args.component(handlers)}</SafeBoundary>, {
          stdin,
          stdout: output,
          stderr: output,
          interactive: true,
          patchConsole: false,
          exitOnCtrlC: false,
        });
      } catch (error) {
        settled = true;
        try {
          instance?.unmount();
        } finally {
          restoreTerminal();
        }
        reject(error);
      }
    });
  } finally {
    if (!settled) restoreTerminal();
  }
}

function streamArgs(streams?: PromptStreams): { stdin?: NodeJS.ReadStream; output?: NodeJS.WriteStream } {
  return streams ? { stdin: streams.input, output: streams.output } : {};
}

export function inkSelect<V>(config: SelectPromptConfig<V>, streams?: PromptStreams): Promise<V> {
  return mountPrompt({
    message: config.message,
    ...streamArgs(streams),
    component: ({ submit, cancel }) => <SelectPrompt config={config} submit={submit} cancel={cancel} />,
  });
}

export function inkCheckbox<V>(config: CheckboxPromptConfig<V>, streams?: PromptStreams): Promise<V[]> {
  return mountPrompt({
    message: config.message,
    ...streamArgs(streams),
    component: ({ submit, fail, cancel }) => <CheckboxPrompt config={config} submit={submit} fail={fail} cancel={cancel} />,
  });
}

export function inkSearch<V>(config: SearchPromptConfig<V>, streams?: PromptStreams): Promise<V> {
  return mountPrompt({
    message: config.message,
    ...streamArgs(streams),
    component: ({ submit, fail, cancel }) => <SearchPrompt config={config} submit={submit} fail={fail} cancel={cancel} />,
  });
}

export function inkInput(config: InputPromptConfig, streams?: PromptStreams): Promise<string> {
  return mountPrompt({
    message: config.message,
    ...streamArgs(streams),
    component: ({ submit, fail, cancel }) => <InputPrompt config={config} secret={false} submit={submit} fail={fail} cancel={cancel} />,
  });
}

export function inkPassword(config: PasswordPromptConfig, streams?: PromptStreams): Promise<string> {
  return mountPrompt({
    message: config.message,
    secret: true,
    signal: config.signal,
    ...streamArgs(streams),
    component: ({ submit, fail, cancel }) => <InputPrompt config={config} secret submit={submit} fail={fail} cancel={cancel} />,
  });
}

/** Hidden compiled-smoke seam: fail while a secret remains in renderer state. */
export function inkSecretRenderFailureSelftest(streams?: PromptStreams): Promise<never> {
  return mountPrompt({
    message: "TUI selftest: secret render failure",
    secret: true,
    ...streamArgs(streams),
    component: ({ cancel }) => <SecretRenderFailurePrompt cancel={cancel} />,
  });
}

export function inkConfirm(config: ConfirmPromptConfig, streams?: PromptStreams): Promise<boolean> {
  return mountPrompt({
    message: config.message,
    ...streamArgs(streams),
    component: ({ submit, cancel }) => <ConfirmPrompt config={config} submit={submit} cancel={cancel} />,
  });
}

export function inkDirectory(config: DirectoryPromptConfig, streams?: PromptStreams): Promise<string> {
  return mountPrompt({
    message: config.message,
    ...streamArgs(streams),
    component: ({ submit, cancel }) => <DirectoryPrompt config={config} submit={submit} cancel={cancel} />,
  });
}

export function inkDirectoryWithStreams(
  config: DirectoryPromptConfig,
  streams: { input: NodeJS.ReadStream; output: NodeJS.WriteStream },
): Promise<string> {
  return mountPrompt({
    message: config.message,
    stdin: streams.input,
    output: streams.output,
    component: ({ submit, cancel }) => <DirectoryPrompt config={config} submit={submit} cancel={cancel} />,
  });
}

export async function inkKeypress(config: KeypressPromptConfig = {}, streams?: PromptStreams): Promise<string | undefined> {
  try {
    return await mountPrompt({
      message: "",
      signal: config.signal,
      ...streamArgs(streams),
      component: ({ submit, cancel }) => <KeypressPrompt submit={submit} cancel={cancel} />,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return undefined;
    throw error;
  }
}
