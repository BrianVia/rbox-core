// Runtime config from Vite env (all PUBLIC — publishable key + API base, no secrets).
// `.env.development` / `.env.production` supply these per `vite --mode`.
//
// N1: fail loud on an obviously-wrong build (prod bundle carrying a dev key, or a
// pk_live pointed at the dev worker) so a misconfigured deploy can't silently ship.

const API_BASE = import.meta.env.VITE_API_BASE as string | undefined;
const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`[rbox config] ${msg}`);
}

assert(API_BASE, 'VITE_API_BASE is unset');
assert(CLERK_PUBLISHABLE_KEY, 'VITE_CLERK_PUBLISHABLE_KEY is unset');
assert(/^pk_(test|live)_/.test(CLERK_PUBLISHABLE_KEY), 'VITE_CLERK_PUBLISHABLE_KEY is malformed');

const isLiveKey = CLERK_PUBLISHABLE_KEY.startsWith('pk_live_');
const isProdApi = API_BASE.startsWith('https://api.rbox.to');

// A live Clerk key must talk to the prod API and vice-versa — never cross them.
assert(
	isLiveKey === isProdApi,
	`env mismatch: clerk key is ${isLiveKey ? 'live' : 'test'} but API base is ${API_BASE}`
);

export const config = {
	apiBase: API_BASE.replace(/\/+$/, ''),
	clerkPublishableKey: CLERK_PUBLISHABLE_KEY,
	isProd: isLiveKey
} as const;
