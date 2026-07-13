// Test preload (bunfig.toml). Design 108's files-first defaults ON in production;
// the broad suite predates that and pins the legacy path — which stays supported
// as the RBOX_FILES_FIRST=0 kill switch. files-first.test.ts sets the flag itself.
process.env.RBOX_FILES_FIRST = "0";
// Designs 109/111/112 also default ON in production (founder call, single-user fleet);
// the broad suite predates the flips and pins the legacy paths — kill-switch
// coverage. The dedicated default tests assert the unset-env defaults are ON.
process.env.RBOX_BATCH_FILL = "v1";
process.env.RBOX_REDEEM_DRAIN = "off";
process.env.RBOX_AUTH_GRANT = "0";
