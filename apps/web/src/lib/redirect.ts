/** Validate a `redirect_url` query value as a same-origin internal path that is
 *  safe to navigate to after sign-in. Returns the path, or null (caller falls
 *  back to /dashboard). The value from `URLSearchParams.get` is ALREADY decoded
 *  once, so a nested query like `/cli-login?code=HLB5-TLH7` arrives intact.
 *
 *  Open-redirect guard: require exactly one leading '/', and reject
 *  protocol-relative ('//host'), backslash tricks ('/\\host'), and absolute
 *  URLs — otherwise `goto`/Clerk could bounce a freshly-authed user to a
 *  phishing origin carrying a live session. */
export function safeInternalPath(raw: string | null | undefined): string | null {
	if (!raw) return null;
	if (raw[0] !== '/') return null; // absolute URLs, bare hosts
	if (raw[1] === '/' || raw[1] === '\\') return null; // //evil.com, /\evil.com
	return raw;
}
