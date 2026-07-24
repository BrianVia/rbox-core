export const EXISTING_ACCOUNT_ENROLLMENT_MESSAGE =
  "account already set up — enroll this machine with `rbox pair` from an enrolled machine, or run `rbox key recover`.";
export const WORKSPACE_SYNC_NEXT_STEP =
  'Run `rbox setup` and choose "Sync an existing workspace" to get your existing folder syncing here.';
const DEVICE_CODE_NOTE_HEADER = "note: device-code login authorized this machine, but encryption is not enrolled.";
const DEVICE_CODE_ENROLL_STEP = "Run `rbox pair` on an enrolled machine or `rbox key recover`.";
/** Wizard mode omits the workspace step (the wizard itself chains there — design
 *  137 R1) and drops the numbering so a single instruction reads as one. */
export function deviceCodeEnrollmentNote(presentation: "standalone" | "wizard"): string {
  return presentation === "wizard"
    ? `${DEVICE_CODE_NOTE_HEADER}\n${DEVICE_CODE_ENROLL_STEP}`
    : `${DEVICE_CODE_NOTE_HEADER}\n1. ${DEVICE_CODE_ENROLL_STEP}\n2. ${WORKSPACE_SYNC_NEXT_STEP}`;
}
export const GENESIS_COMMAND = "rbox key genesis --yes";
export const HEADLESS_GENESIS_COMMAND_NOTE = `note: no encryption keys yet — run \`${GENESIS_COMMAND}\` to set up this first machine.`;
export const ENCRYPTION_ENROLLED_MESSAGE = "encryption enrolled — this workspace will be end-to-end encrypted.";

export type AuthPresentationContext = "standalone" | "wizard";

export function pairingRedemptionSuccessMessages(deviceId: string, presentation: AuthPresentationContext = "standalone"): readonly string[] {
  return presentation === "wizard"
    ? [`device authorized + encryption enrolled: ${deviceId}`]
    : [`device authorized + encryption enrolled: ${deviceId}`, WORKSPACE_SYNC_NEXT_STEP];
}
