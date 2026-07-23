import { redirect } from '@sveltejs/kit';
import { getClerk } from '$lib/clerk';
import { cliLoginReturnPath } from '$lib/device-approval';
import type { PageLoad } from './$types';

// Preserving ?code= across the sign-in bounce is the load-bearing subtlety of this
// route. This page is Clerk-gated like the rest of the app, but unlike the other
// dashboard pages it MUST survive a sign-in round trip without dropping the code the
// CLI put in the URL.
//
// The shared layout (+layout.svelte) owns the signed-out redirect: for any signed-out
// deep link it renders a loader instead of the page (so the page's own in-component
// guard never runs) and calls goto('/') — which strips the query string. The landing
// page then mounts Clerk sign-in with fallbackRedirectUrl:'/dashboard', so a naive
// bounce would strand the user on the dashboard with no code to approve.
//
// We can't touch the layout or the landing page, so we intercept HERE, before the
// layout's redirect effect can run: a load function executes at navigation time
// (client-side; ssr=false), ahead of the layout's onMount/$effect. If the visitor
// isn't signed in we redirect to '/?redirect_url=<this page, code and all>'. The
// root route validates that redirect_url (safeInternalPath) and feeds it to both
// its post-auth effect and Clerk's forceRedirectUrl, returning the user right back
// here with ?code= intact once they authenticate. getClerk() is a singleton the
// layout reuses, so awaiting it here costs nothing extra.
export const load: PageLoad = async ({ url }) => {
	const code = (url.searchParams.get('code') ?? '').toUpperCase();
	const clerk = await getClerk();
	if (!clerk.user) {
		// ssr=false: the live browser fragment is available here, but never in an
		// HTTP request to the device-auth API. Keep it through the Clerk bounce so
		// the approval page can bind consent to the CLI's exact public keys.
		const back = cliLoginReturnPath(code, location.hash);
		redirect(307, `/?redirect_url=${encodeURIComponent(back)}`);
	}
	return { code };
};
