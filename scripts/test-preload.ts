// Test preload (bunfig.toml). Design 108's files-first defaults ON in production;
// the broad suite predates that and pins the legacy path — which stays supported
// as the RBOX_FILES_FIRST=0 kill switch. files-first.test.ts sets the flag itself.
process.env.RBOX_FILES_FIRST = "0";
