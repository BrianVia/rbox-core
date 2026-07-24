export {
  EXISTING_ACCOUNT_ENROLLMENT_MESSAGE,
  WORKSPACE_SYNC_NEXT_STEP,
  deviceCodeEnrollmentNote,
  pairingRedemptionSuccessMessages,
} from "./auth/presentation.js";
export type { AuthPresentationContext } from "./auth/presentation.js";

export {
  runGenesisEnrollment,
  defaultGenesisRecoveryKitCompletion,
  completeStagedGenesisRecoveryKit,
} from "./auth/genesis-command.js";

export {
  deviceCodeLoginShouldPrintWorkspaceStep,
  handleDeviceCodePostApprovalEncryption,
  deviceApprovalUrl,
  transitionDeviceLogin,
  runDeviceCodeLogin,
  login,
} from "./auth/device-login.js";
export type {
  DeviceCodePostApprovalResult,
  DeviceLoginFsmState,
  DeviceLoginFsmEvent,
} from "./auth/device-login.js";

export { logout } from "./auth/session.js";
export { approveDevice, listDevices, revokeDevice } from "./auth/device-commands.js";
export {
  pairCreate,
  pairingConnectCommand,
  presentPairingConnectCommand,
  redeemPair,
  readPairingTokenInteractive,
} from "./auth/pairing-command.js";
export {
  recoverCmd,
  recoveryPhraseFromKeychain,
} from "./auth/recovery-command.js";
export type { RecoverCmdDeps } from "./auth/recovery-command.js";
export {
  keyStatus,
  keyGenesis,
  keyBackup,
  keySave,
} from "./auth/key-commands.js";
export type { KeySaveDeps } from "./auth/key-commands.js";
export { offerRecoveryKitAfterRecover } from "./auth/recovery-kit-flow.js";
