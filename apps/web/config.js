// rbox web dashboard config.
// The Clerk publishable key is PUBLIC by design (pk_test_...) and safe to embed.
// It was read from the repo .env (CLERK_ENVIRONMENTS -> development.publishable_key).
window.RBOX_CONFIG = {
  apiBase: "https://rbox-dev-api.brian-via.workers.dev",
  clerkPublishableKey: "pk_test_Y2VydGFpbi1yYXktMzMuY2xlcmsuYWNjb3VudHMuZGV2JA",
};
