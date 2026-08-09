/**
 * The strict reader every closed state-plane record shares.
 *
 * Design 163 and 222 specify three durable records — the migration control
 * (163:2627), its retirement union, and the genesis intent (222 §2.3) — with
 * one admission rule: unknown, extra, missing, or mistyped members REJECT.
 * That rule is the same code every time, so it is written once here and each
 * record supplies only its own shape and its own refusal error.
 *
 * Pure: no filesystem, no SQLite, no paths.
 */

/** A record-minted identifier that is interpolated into a filesystem path
 * template. Bounded, and free of `/`, `.`, and every other character that could
 * make `path.join` normalize a template out of the directory it was written
 * for: an id is the one member a durable record hands straight to a path
 * constructor, so its charset is the fence. */
export const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type Fields = Readonly<Record<string, Spec>>;
export type Spec =
  | "string" | "id" | "int" | "hex" | "hex32" | "digits"
  | { readonly oneOf: readonly string[] }
  | { readonly const: unknown }
  | { readonly opt: Spec }
  | { readonly list: Spec }
  | { readonly each: Spec }
  | { readonly fields: Fields }
  | { readonly union: { readonly on: string; readonly cases: Readonly<Record<string, Fields>> } };

/** How a record refuses. It must never return. */
export type Refuse = (at: string, why: string) => never;

/** A discriminated union whose every case carries its own tag as a constant. */
export const tagged = (on: string, cases: Readonly<Record<string, Fields>>): Spec => ({
  union: {
    on,
    cases: Object.fromEntries(Object.entries(cases).map(([tag, f]) => [tag, { [on]: { const: tag }, ...f }])),
  },
});

export function checkRecord(value: unknown, spec: Spec, at: string, bad: Refuse): void {
  const plain = (v: unknown, where: string): object =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? v
      : bad(where, "is not an object");
  const v = value;
  if (spec === "string") { if (typeof v !== "string" || v.length === 0) bad(at, "is not a nonempty string"); return; }
  if (spec === "id") { if (typeof v !== "string" || !RECORD_ID.test(v)) bad(at, "is not a path-safe identifier"); return; }
  if (spec === "int") { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) bad(at, "is not a nonnegative safe integer"); return; }
  if (spec === "hex") { if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) bad(at, "is not 64 lowercase hex characters"); return; }
  if (spec === "hex32") { if (typeof v !== "string" || !/^[0-9a-f]{32}$/.test(v)) bad(at, "is not 32 lowercase hex characters"); return; }
  if (spec === "digits") { if (typeof v !== "string" || !/^[0-9]+$/.test(v)) bad(at, "is not decimal digits"); return; }
  if ("oneOf" in spec) { if (!spec.oneOf.includes(v as string)) bad(at, `is not one of ${spec.oneOf.join("|")}`); return; }
  if ("const" in spec) { if (v !== spec.const) bad(at, `is not ${JSON.stringify(spec.const)}`); return; }
  if ("opt" in spec) { if (v !== null) checkRecord(v, spec.opt, at, bad); return; }
  if ("list" in spec) {
    if (!Array.isArray(v)) { bad(at, "is not an array"); return; }
    v.forEach((entry, i) => checkRecord(entry, spec.list, `${at}[${i}]`, bad));
    return;
  }
  if ("each" in spec) {
    for (const [key, entry] of Object.entries(plain(v, at))) checkRecord(entry, spec.each, `${at}.${key}`, bad);
    return;
  }
  if ("union" in spec) {
    const tag: unknown = Reflect.get(plain(v, at), spec.union.on);
    const fields = typeof tag === "string" ? spec.union.cases[tag] : undefined;
    if (!fields) bad(`${at}.${spec.union.on}`, `is not one of ${Object.keys(spec.union.cases).join("|")}`);
    return checkRecord(v, { fields: fields! }, at, bad);
  }
  const o = plain(v, at);
  const keys = Object.keys(spec.fields);
  for (const key of Object.keys(o)) if (!keys.includes(key)) bad(at, `has unknown member ${JSON.stringify(key)}`);
  for (const key of keys) {
    if (!(key in o)) bad(at, `is missing ${JSON.stringify(key)}`);
    const member: unknown = Reflect.get(o, key);
    checkRecord(member, spec.fields[key]!, `${at}.${key}`, bad);
  }
}
