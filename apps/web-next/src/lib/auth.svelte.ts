// Reactive auth state shared across routes. Set once in the root layout after
// ClerkJS loads; `signedIn` tracks Clerk's session via its change listener.
import type { Clerk } from '@clerk/clerk-js';

export const authState = $state<{ clerk: Clerk | null; signedIn: boolean }>({
	clerk: null,
	signedIn: false
});

export function setClerk(c: Clerk): void {
	authState.clerk = c;
	authState.signedIn = !!c.user;
}

export function syncSignedIn(): void {
	authState.signedIn = !!authState.clerk?.user;
}
