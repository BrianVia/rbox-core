import { createHash, type Hash } from "node:crypto";
import type { JsonObject, JsonValue } from "../../../json.js";

export type { JsonObject, JsonValue } from "../../../json.js";

function encode(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires finite numbers");
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
          if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError("canonical JSON rejects sparse arrays");
        }
        return `[${value.map(encode).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical JSON rejects non-JSON object prototypes");
      const members: string[] = [];
      for (const key of Object.keys(value).sort()) {
        const member: unknown = Reflect.get(value, key);
        if (member === undefined) throw new TypeError(`canonical JSON does not admit undefined at ${key}`);
        members.push(`${JSON.stringify(key)}:${encode(member)}`);
      }
      return `{${members.join(",")}}`;
    }
    default:
      throw new TypeError(`canonical JSON does not admit ${typeof value}`);
  }
}

/** rbox-json-canonical-v1: JSON.parse's finite value domain, UTF-16 key order,
 * ECMAScript number spelling, and escaped lone surrogates via JSON.stringify. */
export function canonicalJson(value: unknown): string {
  return encode(value);
}

export function parseCanonicalJson(text: string): JsonValue {
  const value = JSON.parse(text) as JsonValue;
  if (canonicalJson(value) !== text) throw new Error("non-canonical JSON");
  return value;
}

export function utf16beOrderKey(value: string): Buffer {
  const bytes = Buffer.allocUnsafe(value.length * 2);
  for (let index = 0; index < value.length; index++) bytes.writeUInt16BE(value.charCodeAt(index), index * 2);
  return bytes;
}

export function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function frame(hash: Hash, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

export function framedSha256(domain: string, values: Iterable<string | Uint8Array>): string {
  const hash = createHash("sha256");
  frame(hash, domain);
  for (const value of values) frame(hash, value);
  return hash.digest("hex");
}

/** A domain-separated framed hash: tokens go in, one hex digest comes out. */
export interface DomainHash {
  token(value: string | Uint8Array): void;
  digest(): string;
}

export function domainHash(domain: string): DomainHash {
  const hash = createHash("sha256");
  frame(hash, domain);
  return {
    token(value) { frame(hash, value); },
    digest() { return hash.digest("hex"); },
  };
}

export function extrasOf(value: object, known: readonly string[]): string | null {
  const knownSet = new Set(known);
  const extras = Object.entries(value).filter(([key]) => !knownSet.has(key));
  return extras.length === 0 ? null : canonicalJson(Object.fromEntries(extras));
}

export function spreadExtras(text: string | null): JsonObject {
  if (text === null) return {};
  const value = parseCanonicalJson(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("extras_cjson is not an object");
  return value;
}

export function retainedEstimate(value: unknown): number {
  const seen = new Set<object>();
  let containers = 0;
  let scalars = 0;
  let stringCost = 0;
  let arraySlots = 0;
  let objectMembers = 0;
  const add = (left: number, right: number): number => {
    const result = left + right;
    if (!Number.isSafeInteger(result)) throw new RangeError("RetainedEstimateV1 overflow");
    return result;
  };
  const visit = (member: unknown): void => {
    if (member === null) {
      scalars = add(scalars, 1);
      return;
    }
    if (typeof member === "string") {
      scalars = add(scalars, 1);
      stringCost = add(stringCost, add(56, member.length * 2));
      return;
    }
    if (typeof member === "number" || typeof member === "boolean") {
      scalars = add(scalars, 1);
      return;
    }
    if (member === undefined) throw new TypeError("RetainedEstimateV1 rejects undefined");
    if (typeof member !== "object") throw new TypeError(`unsupported retained value ${typeof member}`);
    if (seen.has(member)) throw new TypeError("cyclic value");
    seen.add(member);
    containers = add(containers, 1);
    if (Array.isArray(member)) {
      for (let index = 0; index < member.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(member, index)) throw new TypeError("RetainedEstimateV1 rejects sparse arrays");
        arraySlots = add(arraySlots, 1);
        visit(member[index]);
      }
    } else {
      const prototype = Object.getPrototypeOf(member);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("RetainedEstimateV1 rejects non-JSON object prototypes");
      for (const [key, item] of Object.entries(member)) {
        objectMembers = add(objectMembers, 1);
        stringCost = add(stringCost, add(56, key.length * 2));
        visit(item);
      }
    }
    seen.delete(member);
  };
  visit(value);
  let total = 0;
  total = add(total, 64 * containers);
  total = add(total, 32 * scalars);
  total = add(total, stringCost);
  total = add(total, 16 * arraySlots);
  total = add(total, 96 * objectMembers);
  return Math.ceil(total / 4096) * 4096;
}
