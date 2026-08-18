/** Never: prompting, inventory, or mutation. */
import path from "node:path";

export interface AdoptConsentWitness {
  readonly __adoptConsent: unique symbol;
}

interface ConsentRecord {
  root: string;
  stream: string;
  workspaceId: string;
  route: "interactive" | "wizard" | "headless-flag";
  consumed: boolean;
}

const records = new WeakMap<object, ConsentRecord>();

function mint(record: Omit<ConsentRecord, "consumed">): AdoptConsentWitness {
  const witness = Object.freeze({}) as AdoptConsentWitness;
  records.set(witness, { ...record, root: path.resolve(record.root), consumed: false });
  return witness;
}

export function mintInteractiveAdoptConsent(input: Omit<ConsentRecord, "route" | "consumed">): AdoptConsentWitness {
  return mint({ ...input, route: "interactive" });
}

export function mintWizardAdoptConsent(input: Omit<ConsentRecord, "route" | "consumed">): AdoptConsentWitness {
  return mint({ ...input, route: "wizard" });
}

export function mintHeadlessAdoptConsent(input: Omit<ConsentRecord, "route" | "consumed">): AdoptConsentWitness {
  return mint({ ...input, route: "headless-flag" });
}

export function consumeAdoptConsent(
  witness: AdoptConsentWitness,
  expected: Pick<ConsentRecord, "root" | "stream" | "workspaceId">,
): ConsentRecord {
  const record = records.get(witness);
  if (!record || record.consumed) throw new Error("adoption consent is missing, invalid, or already used");
  if (record.root !== path.resolve(expected.root) || record.stream !== expected.stream || record.workspaceId !== expected.workspaceId) {
    throw new Error("adoption consent does not match this workspace join");
  }
  record.consumed = true;
  return { ...record };
}

