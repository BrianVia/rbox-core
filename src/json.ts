/** Values that can cross a JSON wire or persistence boundary without coercion. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

/** A genuinely open JSON object. Prefer a domain type when the keys are known. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Decode a decoded-JSON member as text. Only a string is identical to its own
 * `String()` rendering: every other JSON member — number, boolean, null, array,
 * object — renders to a value distinct from itself. */
export const jsonText = (value: JsonValue | undefined): value is string => value === String(value);

/** Decode a decoded-JSON member as a keyed object. Only objects and arrays are
 * identical to their own `Object()` boxing, and arrays are excluded explicitly. */
export const jsonObject = (value: JsonValue | undefined): value is JsonObject =>
  !Array.isArray(value) && Object(value) === value;

/** Decode a decoded-JSON member as a nonnegative safe-integer counter. */
export const jsonCounter = (value: JsonValue | undefined): number | undefined =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
