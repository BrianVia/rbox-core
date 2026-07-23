import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('cli-login security boundary', () => {
	it('has a route-specific CSP without dashboard payment origins', () => {
		const headers = readFileSync(resolve('static/_headers'), 'utf8');
		const routePolicy = headers.match(
			/\/cli-login\s+Content-Security-Policy: ([^\n]+)/
		)?.[1];

		expect(routePolicy).toBeTruthy();
		expect(routePolicy).toContain("default-src 'none'");
		expect(routePolicy).toContain("object-src 'none'");
		expect(routePolicy).toContain("frame-ancestors 'none'");
		expect(routePolicy).toContain('https://clerk.rbox.to');
		expect(routePolicy).toContain('__RBOX_SPA_BOOTSTRAP_HASH__');
		const scriptPolicy = routePolicy?.match(/script-src ([^;]+)/)?.[1];
		expect(scriptPolicy).not.toContain("'unsafe-inline'");
		expect(scriptPolicy).not.toContain("'unsafe-eval'");
		// wasm-unsafe-eval IS allowed — Clerk's Turnstile challenge needs WASM
		// compilation, which is far narrower than arbitrary eval/Function.
		expect(scriptPolicy).toContain("'wasm-unsafe-eval'");
		expect(routePolicy).not.toContain('stripe.com');
		expect(scriptPolicy).toContain('https://challenges.cloudflare.com');
		expect(routePolicy).toMatch(
			/frame-src [^;]*https:\/\/challenges\.cloudflare\.com/
		);
	});

	it('renders the approval page as text only', () => {
		const page = readFileSync(resolve('src/routes/cli-login/+page.svelte'), 'utf8');
		expect(page).not.toContain('{@html');
		expect(page).not.toMatch(/innerHTML/i);
	});
});
