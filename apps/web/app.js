// rbox web dashboard — vanilla JS, no build step.
// Flow: Clerk sign-in -> exchange Clerk session JWT for an rbox device token
// -> use rbox token as Bearer for account/usage + billing endpoints.

const CFG = window.RBOX_CONFIG;
const API = CFG.apiBase.replace(/\/+$/, "");
const RBOX_TOKEN_KEY = "rbox_token";
const RBOX_ACCOUNT_KEY = "rbox_account_id";
// Plan deep-link from the marketing site (?plan=solo|pro|team). Stashed so it
// survives the Clerk sign-in redirect, then consumed once the user is signed in.
const PLAN_INTENT_KEY = "rbox_intent_plan";
// Team is "coming soon" (no per-seat billing or member invites yet) — not purchasable.
const VALID_PLANS = ["solo", "pro"];

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = "info") {
  const el = $("status");
  el.textContent = msg || "";
  el.className = kind;
}

function show(id) { $(id).classList.remove("hidden"); }
function hide(id) { $(id).classList.add("hidden"); }

function formatBytes(n) {
  if (n == null || isNaN(n)) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Derive the Clerk Frontend API host from a publishable key. The key is
// `pk_(test|live)_<base64("<fapi-host>$")>`, so we decode the suffix and strip
// the trailing `$`. This lets one static page target prod (clerk.rbox.to) or
// dev (…clerk.accounts.dev) purely from the host-aware key in config.js.
function clerkFapiHost(pk) {
  const enc = pk.slice(pk.indexOf("_", 3) + 1);
  const b64 = enc + "=".repeat((4 - (enc.length % 4)) % 4);
  return atob(b64).replace(/\$+$/, "");
}

// Inject the ClerkJS CDN script for the configured publishable key, then resolve
// once window.Clerk is ready. Replaces the old hardcoded <script> tag so the key
// + FAPI host always match the environment (prod vs dev).
function loadClerk() {
  const pk = CFG.clerkPublishableKey;
  let host;
  try {
    host = clerkFapiHost(pk);
  } catch (_) {
    return Promise.reject(new Error("Invalid Clerk publishable key in config.js"));
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.async = true;
    s.crossOrigin = "anonymous";
    s.setAttribute("data-clerk-publishable-key", pk);
    s.src = `https://${host}/npm/@clerk/clerk-js@latest/dist/clerk.browser.js`;
    s.onerror = () => reject(new Error("ClerkJS failed to load"));
    s.onload = () => {
      const start = Date.now();
      (function poll() {
        if (window.Clerk) return resolve(window.Clerk);
        if (Date.now() - start > 15000) return reject(new Error("ClerkJS failed to initialize"));
        setTimeout(poll, 50);
      })();
    };
    document.head.appendChild(s);
  });
}

// Exchange the Clerk session JWT for an rbox device token (cached in sessionStorage).
async function getRboxToken(clerk) {
  const cached = sessionStorage.getItem(RBOX_TOKEN_KEY);
  if (cached) return cached;

  const clerkToken = await clerk.session.getToken();
  if (!clerkToken) throw new Error("Could not get a Clerk session token");

  const res = await fetch(`${API}/v1/web/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: clerkToken }),
  });

  if (res.status === 404 || res.status === 501) {
    throw new Error("WEB_AUTH_NOT_ENABLED");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Session exchange failed (${res.status})${body ? `: ${body}` : ""}`);
  }

  const data = await res.json();
  if (!data.token) throw new Error("Session exchange returned no token");
  sessionStorage.setItem(RBOX_TOKEN_KEY, data.token);
  if (data.accountId) sessionStorage.setItem(RBOX_ACCOUNT_KEY, data.accountId);
  return data.token;
}

async function api(path, { method = "GET" } = {}) {
  const token = sessionStorage.getItem(RBOX_TOKEN_KEY);
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    // rbox token invalid/expired — drop it so the next load re-exchanges.
    sessionStorage.removeItem(RBOX_TOKEN_KEY);
    throw new Error("Authorization expired — reload to sign in again.");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${method} ${path} failed (${res.status})${body ? `: ${body}` : ""}`);
  }
  return res.json();
}

function renderUsage(u) {
  $("account-id").textContent = sessionStorage.getItem(RBOX_ACCOUNT_KEY) || "—";
  $("plan").textContent = u.plan || "free";

  const used = u.usedBytes ?? 0;
  const cap = u.storageCap ?? 0;
  $("used").textContent = cap
    ? `${formatBytes(used)} / ${formatBytes(cap)}`
    : formatBytes(used);
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  $("usage-bar").style.width = `${pct}%`;

  const ws = u.workspaces ?? 0;
  const wsCap = u.workspaceCap;
  $("workspaces").textContent = wsCap != null ? `${ws} / ${wsCap}` : `${ws}`;

  $("retention").textContent =
    u.retentionDays != null ? `${u.retentionDays} day${u.retentionDays === 1 ? "" : "s"}` : "—";
}

async function redirectTo(path) {
  setStatus("Redirecting…", "info");
  const data = await api(path, { method: "POST" });
  if (!data.url) throw new Error("No redirect URL returned");
  window.location.href = data.url;
}

function wireButtons() {
  document.querySelectorAll(".plans button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await redirectTo(`/v1/billing/checkout?plan=${encodeURIComponent(btn.dataset.plan)}`);
      } catch (e) {
        setStatus(e.message, "error");
      }
    });
  });

  $("manage-billing").addEventListener("click", async () => {
    try {
      await redirectTo(`/v1/billing/portal`);
    } catch (e) {
      setStatus(e.message, "error");
    }
  });

  $("sign-out").addEventListener("click", async () => {
    sessionStorage.removeItem(RBOX_TOKEN_KEY);
    sessionStorage.removeItem(RBOX_ACCOUNT_KEY);
    try {
      await window.Clerk.signOut();
    } catch (_) {
      window.location.reload();
    }
  });
}

async function showSignedIn(clerk) {
  hide("signed-out");
  show("signed-in");
  setStatus("Connecting…", "info");

  try {
    await getRboxToken(clerk);
  } catch (e) {
    if (e.message === "WEB_AUTH_NOT_ENABLED") {
      setStatus("Web auth isn't enabled on the API yet (/v1/web/session is not live).", "error");
      return;
    }
    setStatus(e.message, "error");
    return;
  }

  // Plan deep-link: if the user arrived via a marketing plan button, start that
  // plan's checkout immediately. It binds to their signed-in account (no orphaned
  // payment), so this gives the "payment link" feel without the reconciliation.
  const intent = sessionStorage.getItem(PLAN_INTENT_KEY);
  if (intent) {
    sessionStorage.removeItem(PLAN_INTENT_KEY);
    try {
      setStatus(`Starting ${intent} checkout…`, "info");
      await redirectTo(`/v1/billing/checkout?plan=${encodeURIComponent(intent)}`);
      return; // redirecting to Stripe
    } catch (e) {
      setStatus(e.message, "error"); // fall through to the usual dashboard
    }
  }

  try {
    const usage = await api("/v1/account/usage");
    renderUsage(usage);
    setStatus("", "ok");
  } catch (e) {
    setStatus(e.message, "error");
  }
}

function showSignedOut(clerk) {
  hide("signed-in");
  show("signed-out");
  setStatus("", "info");
  clerk.mountSignIn($("clerk-signin"));
}

async function main() {
  if (!CFG || !CFG.clerkPublishableKey || CFG.clerkPublishableKey.includes("PASTE_PK")) {
    setStatus("Missing Clerk publishable key in config.js.", "error");
    return;
  }

  // Capture a plan deep-link before sign-in so it survives the Clerk redirect.
  const urlPlan = new URLSearchParams(location.search).get("plan");
  if (urlPlan && VALID_PLANS.includes(urlPlan)) {
    sessionStorage.setItem(PLAN_INTENT_KEY, urlPlan);
    history.replaceState(null, "", location.pathname); // don't re-trigger on refresh
  }

  wireButtons();

  let clerk;
  try {
    clerk = await loadClerk();
    await clerk.load();
  } catch (e) {
    setStatus(e.message, "error");
    return;
  }

  const route = () => {
    if (clerk.user) showSignedIn(clerk);
    else showSignedOut(clerk);
  };

  clerk.addListener(({ user }) => {
    // Re-route on auth changes (sign in / sign out).
    if (user) {
      if (!$("signed-in").classList.contains("hidden")) return;
      showSignedIn(clerk);
    } else {
      showSignedOut(clerk);
    }
  });

  route();
}

main();
