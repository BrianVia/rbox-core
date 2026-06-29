// Reactive auth state shared across routes. Set once in the root layout after
// ClerkJS loads; `signedIn` tracks Clerk's session via its change listener.
import { goto } from '$app/navigation';
import type { Clerk } from '@clerk/clerk-js';

export const authState = $state<{ clerk: Clerk | null; signedIn: boolean }>({
	clerk: null,
	signedIn: false
});

export function syncSignedIn(): void {
	authState.signedIn = !!authState.clerk?.user;
}

export function setClerk(c: Clerk): void {
	authState.clerk = c;
	syncSignedIn();
}

// Client-side route guards (ssr=false). Call once at the top of a route's <script>
// so the redirect rule lives in one place instead of a copy-pasted $effect per page.
export function requireAuth(): void {
	$effect(() => {
		if (!authState.signedIn) goto('/');
	});
}

export function redirectIfSignedIn(): void {
	$effect(() => {
		if (authState.signedIn) goto('/dashboard');
	});
}
