// Clerk integration. We use the PREBUILT sign-in-or-up component (B1/B2): it
// handles sign-up, email verification, bot CAPTCHA, Client Trust, MFA, and
// session finalize — everything a hand-rolled flow would have to re-implement.
//
// clerk-js v6 ships its CORE bundled but loads the UI components separately: the
// @clerk/ui bundle is fetched from the Frontend API CDN and handed to
// clerk.load({ ui }). Without it, mountSignIn throws "Clerk was not loaded with
// UI components". (Clerk JS quickstart.)
import { Clerk } from '@clerk/clerk-js';
import { config } from './config';

declare global {
	interface Window {
		__internal_ClerkUICtor?: unknown;
	}
}

let clerkSingleton: Clerk | null = null;

/** Frontend API domain encoded in the publishable key (base64 of "<host>$"). */
function fapiDomain(pk: string): string {
	return atob(pk.split('_')[2]).replace(/\$+$/, '');
}

/** Load the @clerk/ui bundle from the FAPI CDN (once); exposes window.__internal_ClerkUICtor. */
async function loadUiBundle(domain: string): Promise<void> {
	if (window.__internal_ClerkUICtor) return;
	await new Promise<void>((resolve, reject) => {
		const s = document.createElement('script');
		s.src = `https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`;
		s.async = true;
		s.crossOrigin = 'anonymous';
		s.onload = () => resolve();
		s.onerror = () => reject(new Error('failed to load Clerk UI bundle'));
		document.head.appendChild(s);
	});
}

/** Load ClerkJS (core + UI) once for the configured publishable key. */
export async function getClerk(): Promise<Clerk> {
	if (clerkSingleton) return clerkSingleton;
	const domain = fapiDomain(config.clerkPublishableKey);
	await loadUiBundle(domain);
	const c = new Clerk(config.clerkPublishableKey);
	await c.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } } as Parameters<Clerk['load']>[0]);
	clerkSingleton = c;
	return c;
}

/** Mount the prebuilt sign-in (with sign-up) component into `el`. `redirectTarget`
 *  is a caller-validated same-origin path (see safeInternalPath) — forced so the
 *  full-page Clerk flows (email verification, OAuth) land on the intended deep
 *  link too, agreeing with the SPA's own post-auth effect. */
export function mountAuth(clerk: Clerk, el: HTMLDivElement, redirectTarget: string = '/dashboard'): void {
	clerk.mountSignIn(el, {
		// Single component that also offers "create account" → covers the marketing funnel.
		withSignUp: true,
		forceRedirectUrl: redirectTarget,
		signUpForceRedirectUrl: redirectTarget,
		fallbackRedirectUrl: '/dashboard',
		signUpFallbackRedirectUrl: '/dashboard'
	});
}

/** Clerk session id for the active session, or null when signed out. */
export function sessionId(clerk: Clerk): string | null {
	return clerk.session?.id ?? null;
}

/** Require a new Clerk reverification ceremony and then mint a non-cached
 *  session JWT carrying the freshly-updated factor-verification-age claims.
 *  The API verifies those signed claims; a cached rbox bearer is not proof. */
export async function freshClerkStepUpToken(clerk: Clerk): Promise<string> {
	const originalSessionId = clerk.session?.id;
	if (!originalSessionId) throw new Error('Sign in again before approving this machine.');

	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (result: () => void) => {
			if (settled) return;
			settled = true;
			result();
		};

		clerk.__internal_openReverification({
			// Clerk falls back to a fresh first factor when the account has no
			// second factor. The server applies the same fva interpretation.
			level: 'multi_factor',
			afterVerification: () => finish(resolve),
			afterVerificationCancelled: () =>
				finish(() => reject(new Error('Verification was cancelled. Nothing was approved.')))
		});
	});

	if (clerk.session?.id !== originalSessionId) {
		throw new Error('Your signed-in session changed. Start the approval again.');
	}
	const token = await clerk.session.getToken({ skipCache: true });
	if (!token) throw new Error('We couldn’t confirm your sign-in. Try again.');
	return token;
}
