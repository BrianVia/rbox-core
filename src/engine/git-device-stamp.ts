/**
 * The wire contract of `GitSection.deviceId` — the device that captured a
 * section (design 274 D1). One rule, shared by the producer (`captureGitState`)
 * and by every reader that wants to name the machine a paused change came from,
 * so a stamp is written and interpreted against a single definition.
 *
 * TRUST THE FLEET (founder ruling, design 274 r3): enrollment is rigorous, so
 * an id is never shape-policed — real ids include the environment-credential
 * literal "env" and client-supplied API keys with no `dev_` prefix. Only an
 * unbounded one is refused, and that bound is manifest hygiene, not trust.
 *
 * READER-TOLERATE: an absent, empty, mistyped, or oversized stamp means the
 * section carries NO AUTHOR — never that the section is invalid. `deviceId` is
 * deliberately absent from `validateGitSection` for exactly this reason: that
 * validator runs fail-closed inside the state codecs (`encodeGitSection`,
 * `encodeRepoRecord`), so policing an additive attribution field there would
 * let a workspace author sections its own state plane refuses to persist. It is
 * the same discipline `config` follows (design 93 v12).
 *
 * Readers that DISPLAY the value sanitize it at their own render boundary,
 * exactly as they already do for server-supplied device labels.
 */
import type { WireCandidate } from "./manifest-validate.js";

const MAX_DEVICE_ID_LENGTH = 200;

/** True only for a primitive string: every other wire value differs from its own
 *  string spelling (`5 !== "5"`, `["a"] !== "a"`), so this narrows a value the
 *  declared type claims is a string without a runtime type interrogation. */
const isWireString = (value: WireCandidate<string | undefined>): value is string => value === `${value}`;

/** The section's author, or `undefined` when it has none this reader can use. */
export const gitSectionDeviceId = (deviceId: WireCandidate<string | undefined>): string | undefined =>
  isWireString(deviceId) && deviceId.length > 0 && deviceId.length <= MAX_DEVICE_ID_LENGTH ? deviceId : undefined;
