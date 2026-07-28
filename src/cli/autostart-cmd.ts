export { BOOT_RESUME_MARKER } from "./autostart/install.js";
export type {
  DesiredDaemonStateValue,
  DaemonMaintenance,
  DesiredDaemonState,
  DesiredStateRow,
  AutostartWorkspaceStatus,
} from "./autostart/desired-state.js";
export { desiredStatePath, readDesiredDaemonRows, autostartWorkspaceStatuses } from "./autostart/desired-state.js";
export {
  startDaemonAndRecordDesired,
  startDaemonForUser,
  resumeDesiredDaemon,
  stopDaemonAndRecordDesired,
  DaemonMaintenanceConflictError,
  readDaemonMaintenance,
  parkDaemonForMaintenance,
  resumeDaemonAfterMaintenance,
  promotePendingModeIntent,
} from "./autostart/daemon-state.js";
export { bootResume } from "./autostart/boot-resume.js";
export { enableAutostart, disableAutostart, isAutostartEnabled } from "./autostart/install.js";
export { autostartCmd } from "./autostart/command.js";
