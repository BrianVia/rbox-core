import * as barrel from "./auth-cmd.js";
import * as deviceLogin from "./auth/device-login.js";
import * as deviceCommands from "./auth/device-commands.js";
import * as genesisCommand from "./auth/genesis-command.js";
import * as keyCommands from "./auth/key-commands.js";
import * as pairingCommand from "./auth/pairing-command.js";
import * as presentation from "./auth/presentation.js";
import * as recoveryCommand from "./auth/recovery-command.js";
import * as recoveryKitFlow from "./auth/recovery-kit-flow.js";
import * as session from "./auth/session.js";
import type {
  AuthPresentationContext,
  DeviceCodePostApprovalResult,
  DeviceLoginFsmEvent,
  DeviceLoginFsmState,
  KeySaveDeps,
  RecoverCmdDeps,
} from "./auth-cmd.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;

type OwnerValues =
  & Pick<typeof presentation, "EXISTING_ACCOUNT_ENROLLMENT_MESSAGE" | "WORKSPACE_SYNC_NEXT_STEP" | "deviceCodeEnrollmentNote" | "pairingRedemptionSuccessMessages">
  & Pick<typeof genesisCommand, "runGenesisEnrollment" | "defaultGenesisRecoveryKitCompletion" | "completeStagedGenesisRecoveryKit">
  & Pick<typeof deviceLogin, "deviceCodeLoginShouldPrintWorkspaceStep" | "handleDeviceCodePostApprovalEncryption" | "deviceApprovalUrl" | "transitionDeviceLogin" | "runDeviceCodeLogin" | "login">
  & Pick<typeof session, "logout">
  & Pick<typeof deviceCommands, "approveDevice" | "listDevices" | "revokeDevice">
  & Pick<typeof pairingCommand, "pairCreate" | "pairingConnectCommand" | "presentPairingConnectCommand" | "redeemPair" | "readPairingTokenInteractive">
  & Pick<typeof recoveryCommand, "recoverCmd" | "recoveryPhraseFromKeychain">
  & Pick<typeof keyCommands, "keyStatus" | "keyGenesis" | "keyBackup" | "keySave">
  & Pick<typeof recoveryKitFlow, "offerRecoveryKitAfterRecover">;

type _ValueKeysAreExact = Assert<Equal<keyof typeof barrel, keyof OwnerValues>>;
type _BarrelValuesMatchOwners = Assert<typeof barrel extends OwnerValues ? true : false>;
type _OwnerValuesMatchBarrel = Assert<OwnerValues extends typeof barrel ? true : false>;
type _PresentationType = Assert<Equal<AuthPresentationContext, presentation.AuthPresentationContext>>;
type _PostApprovalType = Assert<Equal<DeviceCodePostApprovalResult, deviceLogin.DeviceCodePostApprovalResult>>;
type _FsmStateType = Assert<Equal<DeviceLoginFsmState, deviceLogin.DeviceLoginFsmState>>;
type _FsmEventType = Assert<Equal<DeviceLoginFsmEvent, deviceLogin.DeviceLoginFsmEvent>>;
type _RecoverDepsType = Assert<Equal<RecoverCmdDeps, recoveryCommand.RecoverCmdDeps>>;
type _KeySaveDepsType = Assert<Equal<KeySaveDeps, keyCommands.KeySaveDeps>>;

export {};
