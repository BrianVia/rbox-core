import { redirect } from '@sveltejs/kit';

// The worker's Checkout cancel_url + portal return_url point at ${RBOX_APP_URL}/billing
// (B4). Land them on the dashboard.
export function load() {
	redirect(307, '/dashboard');
}
