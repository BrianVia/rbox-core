import path from "node:path";

/**
 * An opaque, invocation-local proof that setup showed the rebind consequence
 * and the user accepted it. Runtime authenticity lives in this module's
 * WeakMap; object shape (or a TypeScript cast) cannot forge a witness.
 */
export interface ResetConsentWitness {
  readonly __resetConsentWitness: never;
}

export type ResetConsentKind = "setup-rebind" | "setup-create";

export interface ResetConsentInspection {
  root: string;
  observedOldStream: string;
  observedOldNonce: string | undefined;
  nextStream: string;
  consentKind: ResetConsentKind;
  mintedAtRevision: number;
}

export type ResetConsentIntentInspection = Readonly<{
  root: string;
  observedOldStream: string;
  observedOldNonce: string | undefined;
  mintedAtRevision: number;
  intent:
    | { kind: "existing"; remoteUrl: string; workspaceId: string; projectId: string }
    | { kind: "create"; remoteUrl: string; projectId: string };
}>;

interface ExistingIntent {
  kind: "existing";
  remoteUrl: string;
  workspaceId: string;
  projectId: string;
}

interface CreateIntent {
  kind: "create";
  remoteUrl: string;
  projectId: string;
}

interface ConsentRecord {
  root: string;
  observedOldStream: string;
  observedOldNonce: string | undefined;
  intent: ExistingIntent | CreateIntent;
  mintedAtRevision: number;
  mintedAtMs: number;
  nextStream?: string;
  narrowingStarted: boolean;
  narrowed: boolean;
  consumed: boolean;
}

const records = new WeakMap<object, ConsentRecord>();
const MAX_WITNESS_AGE_MS = 30 * 60 * 1000;

export class ResetConsentError extends Error {
  readonly name = "ResetConsentError";

  constructor(
    readonly reason:
      | "invalid"
      | "expired"
      | "consumed"
      | "tuple-mismatch"
      | "not-narrowed"
      | "already-narrowed",
    message: string,
  ) {
    super(message);
  }
}

export class RebindConsentRequiredError extends Error {
  readonly name = "RebindConsentRequiredError";

  constructor(readonly root: string) {
    super(`refusing to rebind ${root} without setup confirmation; run \`rbox setup\` and confirm the reset of local sync history`);
  }
}

function streamId(remoteUrl: string, workspaceId: string, projectId: string): string {
  return `${remoteUrl}::${workspaceId}::${projectId}`;
}

function witness(record: ConsentRecord): ResetConsentWitness {
  const value = Object.freeze(Object.create(null)) as ResetConsentWitness;
  records.set(value, record);
  return value;
}

function recordFor(value: ResetConsentWitness): ConsentRecord {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new ResetConsentError("invalid", "reset consent witness is invalid");
  }
  const record = records.get(value as object);
  if (!record) throw new ResetConsentError("invalid", "reset consent witness is invalid");
  if (record.consumed) throw new ResetConsentError("consumed", "reset consent witness was already consumed");
  if (Date.now() - record.mintedAtMs > MAX_WITNESS_AGE_MS) {
    throw new ResetConsentError("expired", "reset consent witness expired; confirm the rebind again");
  }
  return record;
}

interface CommonMintInput {
  root: string;
  observedOldStream: string;
  observedOldNonce: string | undefined;
  mintedAtRevision: number;
}

/** Minted only by setup's explicit consequence-confirmation boundary. */
export function mintSetupExistingConsent(input: CommonMintInput & {
  remoteUrl: string;
  workspaceId: string;
  projectId: string;
}): ResetConsentWitness {
  const nextStream = streamId(input.remoteUrl, input.workspaceId, input.projectId);
  return witness({
    root: path.resolve(input.root),
    observedOldStream: input.observedOldStream,
    observedOldNonce: input.observedOldNonce,
    intent: {
      kind: "existing",
      remoteUrl: input.remoteUrl,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    },
    mintedAtRevision: input.mintedAtRevision,
    mintedAtMs: Date.now(),
    nextStream,
    narrowingStarted: false,
    narrowed: true,
    consumed: false,
  });
}

/** Minted only by setup's explicit consequence-confirmation boundary. */
export function mintSetupCreateConsent(input: CommonMintInput & {
  remoteUrl: string;
  projectId: string;
}): ResetConsentWitness {
  return witness({
    root: path.resolve(input.root),
    observedOldStream: input.observedOldStream,
    observedOldNonce: input.observedOldNonce,
    intent: { kind: "create", remoteUrl: input.remoteUrl, projectId: input.projectId },
    mintedAtRevision: input.mintedAtRevision,
    mintedAtMs: Date.now(),
    narrowingStarted: false,
    narrowed: false,
    consumed: false,
  });
}

/**
 * The sole create-new narrowing path. The stream-selecting tuple is checked
 * before the POST callback runs; only the id returned by that exact callback is
 * stamped into the same witness. Display-only `name` deliberately rides beside
 * the verified tuple without selecting a stream.
 */
export async function createWorkspaceWithConsent(
  value: ResetConsentWitness,
  args: { remoteUrl: string; projectId: string; name?: string },
  create: () => Promise<string>,
): Promise<{ workspaceId: string; witness: ResetConsentWitness }> {
  const record = recordFor(value);
  if (record.intent.kind !== "create"
    || record.intent.remoteUrl !== args.remoteUrl
    || record.intent.projectId !== args.projectId) {
    throw new ResetConsentError("tuple-mismatch", "workspace create arguments do not match the confirmed rebind destination");
  }
  if (record.narrowingStarted || record.narrowed) {
    throw new ResetConsentError("already-narrowed", "create consent witness can only be narrowed once");
  }
  record.narrowingStarted = true;
  let workspaceId: string;
  try {
    workspaceId = await create();
  } catch (error) {
    // A failed POST did not return an id and therefore did not narrow the
    // witness. It remains unusable rather than authorizing a second POST.
    throw error;
  }
  if (!workspaceId) throw new ResetConsentError("invalid", "workspace create returned no workspace id");
  record.nextStream = streamId(args.remoteUrl, workspaceId, args.projectId);
  record.narrowed = true;
  return { workspaceId, witness: value };
}

/** Pure Stage-A inspection used by init's before-POST refusal preflight. */
export function inspectResetConsentIntent(value: ResetConsentWitness): ResetConsentIntentInspection {
  const record = recordFor(value);
  return Object.freeze({
    root: record.root,
    observedOldStream: record.observedOldStream,
    observedOldNonce: record.observedOldNonce,
    mintedAtRevision: record.mintedAtRevision,
    intent: Object.freeze({ ...record.intent }),
  });
}

/** Pure validity/expiry/consumed check. It authorizes no mutation by itself. */
export function inspectResetConsent(value: ResetConsentWitness): Readonly<ResetConsentInspection> {
  const record = recordFor(value);
  if (!record.narrowed || record.nextStream === undefined) {
    throw new ResetConsentError("not-narrowed", "create consent witness has not been narrowed to a returned workspace id");
  }
  return Object.freeze({
    root: record.root,
    observedOldStream: record.observedOldStream,
    observedOldNonce: record.observedOldNonce,
    nextStream: record.nextStream,
    consentKind: record.intent.kind === "create" ? "setup-create" : "setup-rebind",
    mintedAtRevision: record.mintedAtRevision,
  });
}

/**
 * Compare every bound coordinate and consume exactly once. Callers perform this
 * under the complete reset fence after their lineage recheck.
 */
export function consumeResetConsent(
  value: ResetConsentWitness,
  expected: Pick<ResetConsentInspection, "root" | "observedOldStream" | "observedOldNonce" | "nextStream">,
): Readonly<ResetConsentInspection> {
  const inspected = inspectResetConsent(value);
  if (inspected.root !== path.resolve(expected.root)
    || inspected.observedOldStream !== expected.observedOldStream
    || inspected.observedOldNonce !== expected.observedOldNonce
    || inspected.nextStream !== expected.nextStream) {
    throw new ResetConsentError("tuple-mismatch", "reset consent witness does not match the fenced state lineage and destination");
  }
  records.get(value as object)!.consumed = true;
  return inspected;
}
