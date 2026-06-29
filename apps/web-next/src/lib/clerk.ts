// Clerk integration. We use the PREBUILT sign-in-or-up component (B1/B2): it
// handles sign-up, email verification, bot CAPTCHA, Client Trust, MFA, and
// session finalize — everything a hand-rolled flow would have to re-implement.
import { Clerk } from '@clerk/clerk-js';
import { config } from './config';

let clerkSingleton: Clerk | null = null;

/** Load ClerkJS once for the configured publishable key. */
export async function getClerk(): Promise<Clerk> {
	if (clerkSingleton) return clerkSingleton;
	const c = new Clerk(config.clerkPublishableKey);
	await c.load();
	clerkSingleton = c;
	return c;
}

/** Mount the prebuilt sign-in (with sign-up) component into `el`. */
export function mountAuth(clerk: Clerk, el: HTMLDivElement): void {
	clerk.mountSignIn(el, {
		// Single component that also offers "create account" → covers the marketing funnel.
		withSignUp: true,
		fallbackRedirectUrl: '/dashboard',
		signUpFallbackRedirectUrl: '/dashboard'
	});
}

/** Clerk session id for the active session, or null when signed out. */
export function sessionId(clerk: Clerk): string | null {
	return clerk.session?.id ?? null;
}
