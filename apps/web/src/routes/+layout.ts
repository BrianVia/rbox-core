// Pure client-rendered SPA — Clerk + the rbox token live only in the browser, and
// the worker is the backend. No SSR, no prerender; the static adapter emits a
// 200.html fallback so deep links resolve client-side.
export const ssr = false;
export const prerender = false;
export const trailingSlash = 'never';
