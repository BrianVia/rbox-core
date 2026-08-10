export interface MachineSpec {
  name: string;
  enrolled: boolean;
}

interface Assertions {
  assertStdout?: RegExp[];
  assertNotStdout?: RegExp[];
  assertStderr?: RegExp[];
  expectExit?: number;
}

export type FlowStep =
  | ({ on: string; exec: string[] } & Assertions)
  | ({ on: string; guest: string } & Assertions)
  | { on: string; tui: string }
  | { on: string; keys: string[] }
  | { on: string; typeVar: string }
  | { on: string; waitFor: RegExp; timeout?: number }
  | { on: string; assertScreen: RegExp[]; assertNotScreen?: RegExp[] }
  | { on: string; pollUntil: { exec: string[]; pattern: RegExp; timeout?: number } }
  | { on: string; captureVar: { name: string; pattern: RegExp } };

export interface FlowDefinition {
  name: string;
  status: "pass" | "pending-137";
  machines: MachineSpec[];
  steps: FlowStep[];
}

const STEP_KEYS = ["exec", "guest", "tui", "keys", "typeVar", "waitFor", "assertScreen", "pollUntil", "captureVar"] as const;
const ASSERTION_KEYS = new Set(["on", "assertStdout", "assertNotStdout", "assertStderr", "expectExit"]);

interface FlowConfigObject {
  name?: unknown; status?: unknown; machines?: unknown; steps?: unknown;
  on?: unknown; exec?: unknown; guest?: unknown; tui?: unknown; keys?: unknown; typeVar?: unknown;
  waitFor?: unknown; timeout?: unknown; assertScreen?: unknown; assertNotScreen?: unknown;
  pollUntil?: unknown; captureVar?: unknown; assertStdout?: unknown; assertNotStdout?: unknown;
  assertStderr?: unknown; expectExit?: unknown; enrolled?: unknown; pattern?: unknown;
}

function objectAt(value: unknown, at: string): FlowConfigObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${at} must be an object`);
  return value as FlowConfigObject;
}

function stringAt(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${at} must be a non-empty string`);
  return value;
}

function stringArrayAt(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${at} must be a non-empty string array`);
  }
  return value as string[];
}

function argvAt(value: unknown, at: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${at} must be ${allowEmpty ? "a" : "a non-empty"} string array`);
  }
  return value as string[];
}

function regexAt(value: unknown, at: string): RegExp {
  if (!(value instanceof RegExp)) throw new Error(`${at} must be a RegExp`);
  return value;
}

function regexArrayAt(value: unknown, at: string): RegExp[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${at} must be a non-empty RegExp array`);
  return value.map((entry, index) => regexAt(entry, `${at}[${index}]`));
}

function timeoutAt(value: unknown, at: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || Number(value) <= 0) throw new Error(`${at} must be a positive number of seconds`);
  return Number(value);
}

function rejectUnknownKeys(step: FlowConfigObject, allowed: Set<string>, at: string): void {
  const unknown = Object.keys(step).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${at} has unknown field ${JSON.stringify(unknown[0])}`);
}

function validateStep(value: unknown, index: number, machines: Set<string>, sessions: Set<string>): FlowStep {
  const at = `flow.steps[${index}]`;
  const step = objectAt(value, at);
  const on = stringAt(step.on, `${at}.on`);
  if (!machines.has(on)) throw new Error(`${at}.on names unknown machine ${JSON.stringify(on)}`);
  const discriminants = STEP_KEYS.filter((key) => step[key] !== undefined);
  if (discriminants.length !== 1) {
    throw new Error(`${at} must contain exactly one step discriminator (${STEP_KEYS.join(", ")}); found ${discriminants.length}`);
  }
  const kind = discriminants[0]!;
  if (kind === "exec" || kind === "guest") {
    rejectUnknownKeys(step, new Set([...ASSERTION_KEYS, kind]), at);
    if (kind === "exec") argvAt(step.exec, `${at}.exec`, true);
    else stringAt(step.guest, `${at}.guest`);
    if (step.assertStdout !== undefined) regexArrayAt(step.assertStdout, `${at}.assertStdout`);
    if (step.assertNotStdout !== undefined) regexArrayAt(step.assertNotStdout, `${at}.assertNotStdout`);
    if (step.assertStderr !== undefined) regexArrayAt(step.assertStderr, `${at}.assertStderr`);
    if (step.expectExit !== undefined && (!Number.isInteger(step.expectExit) || Number(step.expectExit) < 0)) throw new Error(`${at}.expectExit must be a non-negative integer`);
  } else if (kind === "tui") {
    rejectUnknownKeys(step, new Set(["on", "tui"]), at);
    stringAt(step.tui, `${at}.tui`);
    if (sessions.has(on)) throw new Error(`${at} starts a second live TUI session on machine ${JSON.stringify(on)}`);
    sessions.add(on);
  } else if (kind === "keys") {
    rejectUnknownKeys(step, new Set(["on", "keys"]), at); stringArrayAt(step.keys, `${at}.keys`);
    if (!sessions.has(on)) throw new Error(`${at}.keys requires a live TUI session on machine ${JSON.stringify(on)}`);
  } else if (kind === "typeVar") {
    rejectUnknownKeys(step, new Set(["on", "typeVar"]), at); stringAt(step.typeVar, `${at}.typeVar`);
    if (!sessions.has(on)) throw new Error(`${at}.typeVar requires a live TUI session on machine ${JSON.stringify(on)}`);
  } else if (kind === "waitFor") {
    rejectUnknownKeys(step, new Set(["on", "waitFor", "timeout"]), at); regexAt(step.waitFor, `${at}.waitFor`); timeoutAt(step.timeout, `${at}.timeout`);
    if (!sessions.has(on)) throw new Error(`${at}.waitFor requires a live TUI session on machine ${JSON.stringify(on)}`);
  } else if (kind === "assertScreen") {
    rejectUnknownKeys(step, new Set(["on", "assertScreen", "assertNotScreen"]), at); regexArrayAt(step.assertScreen, `${at}.assertScreen`);
    if (step.assertNotScreen !== undefined) regexArrayAt(step.assertNotScreen, `${at}.assertNotScreen`);
    if (!sessions.has(on)) throw new Error(`${at}.assertScreen requires a live TUI session on machine ${JSON.stringify(on)}`);
  } else if (kind === "pollUntil") {
    rejectUnknownKeys(step, new Set(["on", "pollUntil"]), at);
    const poll = objectAt(step.pollUntil, `${at}.pollUntil`);
    rejectUnknownKeys(poll, new Set(["exec", "pattern", "timeout"]), `${at}.pollUntil`);
    argvAt(poll.exec, `${at}.pollUntil.exec`); regexAt(poll.pattern, `${at}.pollUntil.pattern`); timeoutAt(poll.timeout, `${at}.pollUntil.timeout`);
  } else {
    rejectUnknownKeys(step, new Set(["on", "captureVar"]), at);
    const capture = objectAt(step.captureVar, `${at}.captureVar`);
    rejectUnknownKeys(capture, new Set(["name", "pattern"]), `${at}.captureVar`);
    stringAt(capture.name, `${at}.captureVar.name`); regexAt(capture.pattern, `${at}.captureVar.pattern`);
    if (index === 0) throw new Error(`${at}.captureVar requires a previous step result`);
  }
  return step as FlowStep;
}

/** Runtime validation keeps hand-authored flow modules from failing deep in a live run. */
export function defineFlow(value: FlowDefinition): FlowDefinition {
  const flow = objectAt(value, "flow");
  const name = stringAt(flow.name, "flow.name");
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("flow.name must be lowercase kebab-case");
  if (flow.status !== "pass" && flow.status !== "pending-137") throw new Error("flow.status must be pass or pending-137");
  if (!Array.isArray(flow.machines) || flow.machines.length === 0) throw new Error("flow.machines must be a non-empty array");
  const names = new Set<string>();
  for (let index = 0; index < flow.machines.length; index++) {
    const machine = objectAt(flow.machines[index], `flow.machines[${index}]`);
    rejectUnknownKeys(machine, new Set(["name", "enrolled"]), `flow.machines[${index}]`);
    const machineName = stringAt(machine.name, `flow.machines[${index}].name`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(machineName)) throw new Error(`flow.machines[${index}].name is not a safe machine name`);
    if (typeof machine.enrolled !== "boolean") throw new Error(`flow.machines[${index}].enrolled must be boolean`);
    if (names.has(machineName)) throw new Error(`flow.machines has duplicate machine ${JSON.stringify(machineName)}`);
    names.add(machineName);
  }
  if (flow.machines.filter((candidate) => (candidate as MachineSpec).enrolled).length > 1) throw new Error("flow may bootstrap at most one account");
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) throw new Error("flow.steps must be a non-empty array");
  const sessions = new Set<string>();
  flow.steps.forEach((step, index) => validateStep(step, index, names, sessions));
  return value;
}

export function stepKind(step: FlowStep): typeof STEP_KEYS[number] {
  return STEP_KEYS.find((key) => key in step)!;
}
