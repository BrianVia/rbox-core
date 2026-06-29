// rbox web dashboard config.
// Clerk publishable keys are PUBLIC by design (pk_live_/pk_test_) and safe to embed.
// Host-aware: the production dashboard (app.rbox.to) talks to the prod worker +
// the production Clerk instance (clerk.rbox.to); anything else (localhost) uses
// the dev worker + dev Clerk instance.
const isProd = location.hostname === "app.rbox.to";
window.RBOX_CONFIG = isProd
  ? {
      apiBase: "https://api.rbox.to",
      clerkPublishableKey: "pk_live_Y2xlcmsucmJveC50byQ",
    }
  : {
      apiBase: "https://rbox-dev-api.brian-via.workers.dev",
      clerkPublishableKey: "pk_test_Y29zbWljLXBob2VuaXgtNTEuY2xlcmsuYWNjb3VudHMuZGV2JA",
    };
