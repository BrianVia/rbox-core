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
