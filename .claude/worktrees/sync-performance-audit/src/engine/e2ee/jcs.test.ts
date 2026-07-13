import { describe, expect, test } from "bun:test";
import { canonicalString, canonicalize, parseStrict, verifyRoundTrip } from "./jcs.js";

describe("jcs canonicalize", () => {
  test("sorts object keys lexicographically (UTF-16 code units)", () => {
    expect(canonicalString({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
    // sorting is over code units, so capital letters precede lowercase
    expect(canonicalString({ a: 1, A: 2 })).toBe('{"A":2,"a":1}');
  });

  test("nested objects/arrays are canonical recursively, no whitespace", () => {
    expect(canonicalString({ z: [{ y: 1, x: 2 }], a: true })).toBe('{"a":true,"z":[{"x":2,"y":1}]}');
  });

  test("omits undefined-valued keys, encodes null", () => {
    expect(canonicalString({ a: undefined, b: null, c: 1 })).toBe('{"b":null,"c":1}');
  });

  test("two key orderings of the same object produce identical bytes", () => {
    const a = canonicalize({ seq: 1, parentSeq: 0, deviceId: "d" });
    const b = canonicalize({ deviceId: "d", parentSeq: 0, seq: 1 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test("rejects floats, negatives, NaN, unsafe integers", () => {
    expect(() => canonicalString({ a: 1.5 })).toThrow();
    expect(() => canonicalString({ a: -1 })).toThrow();
    expect(() => canonicalString({ a: NaN })).toThrow();
    expect(() => canonicalString({ a: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });

  test("rejects unsupported types (bigint, function, symbol)", () => {
    expect(() => canonicalString({ a: 1n })).toThrow();
    expect(() => canonicalString({ a: () => 0 })).toThrow();
  });
});

describe("jcs parseStrict / verifyRoundTrip", () => {
  test("accepts a canonical document", () => {
    const text = '{"a":1,"b":[2,3]}';
    expect(parseStrict(text)).toEqual({ a: 1, b: [2, 3] });
    expect(verifyRoundTrip(text)).toEqual({ a: 1, b: [2, 3] });
  });

  test("rejects duplicate keys", () => {
    expect(() => parseStrict('{"a":1,"a":2}')).toThrow(/duplicate key/);
    // duplicate nested key
    expect(() => parseStrict('{"x":{"k":1,"k":2}}')).toThrow(/duplicate key/);
  });

  test("does not flag a string value that repeats an earlier key name", () => {
    // "a" appears as a value, not a duplicate key
    expect(() => parseStrict('{"a":"a","b":"a"}')).not.toThrow();
  });

  test("does not flag repeated keys across SIBLING objects", () => {
    expect(() => parseStrict('[{"k":1},{"k":2}]')).not.toThrow();
  });

  test("rejects non-integer / negative / unsafe numbers in untrusted text", () => {
    expect(() => parseStrict('{"a":1.5}')).toThrow();
    expect(() => parseStrict('{"a":-3}')).toThrow();
    expect(() => parseStrict('{"a":1e3}')).toThrow();
    expect(() => parseStrict('{"a":9007199254740993}')).toThrow(/unsafe/);
  });

  test("verifyRoundTrip rejects non-canonical (unsorted / spaced) input", () => {
    expect(() => verifyRoundTrip('{"b":1,"a":2}')).toThrow(/canonical/);
    expect(() => verifyRoundTrip('{"a": 1}')).toThrow(/canonical/);
  });

  test("number tokens are not confused by digits inside strings", () => {
    expect(() => parseStrict('{"a":"1.5","b":"-9"}')).not.toThrow();
  });

  test("array string ELEMENTS are values, not keys (no false duplicate)", () => {
    // regression: a JSON array of identical strings must not trip dup-key detection
    expect(() => parseStrict('{"hashes":["aa","aa","bb"]}')).not.toThrow();
    // array of objects each repeating the same key name across elements is fine
    expect(() => parseStrict('[{"k":1},{"k":2},{"k":3}]')).not.toThrow();
    // but a real duplicate key inside one of those objects still throws
    expect(() => parseStrict('[{"k":1,"k":2}]')).toThrow(/duplicate key/);
  });

  test("nested arrays/objects keep object key-sets independent", () => {
    expect(() => parseStrict('{"a":{"x":1},"b":{"x":2}}')).not.toThrow();
    expect(() => parseStrict('{"a":["x","x"],"x":1}')).not.toThrow();
  });
});
