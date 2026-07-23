<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { authState, redirectIfSignedIn } from '$lib/auth.svelte';
	import { mountAuth } from '$lib/clerk';
	import { peekPlanIntent, stashPlanIntent } from '$lib/plan-intent';
	import { safeInternalPath } from '$lib/redirect';

	let host = $state<HTMLDivElement>();
	const PLANS = {
		solo: { name: 'Solo', monthly: '$8/month', annual: '$80/year' },
		pro: { name: 'Pro', monthly: '$20/month', annual: '$200/year' }
	} as const;

	// "/" is the ONE place the marketing pricing CTA (?plan=solo|pro) lands — for both
	// signed-out buyers (before the Clerk redirect dance) and already-signed-in ones
	// (before redirectIfSignedIn below). Stash the intent here, ahead of either
	// redirect, so the dashboard can pick it up and auto-start checkout.
	if (stashPlanIntent(page.url.searchParams.get('plan'), page.url.searchParams.get('cadence'))) {
		// Strip the consumed param (keeping others, e.g. Clerk's redirect_url) so a
		// Back-navigation to this history entry can't re-stash and re-fire checkout.
		// Raw history.replaceState, not $app/navigation's — the router isn't
		// initialized yet at script-eval time, and no navigation has happened.
		const url = new URL(location.href);
		url.searchParams.delete('plan');
		url.searchParams.delete('cadence');
		history.replaceState(history.state, '', url);
	}

	const planIntent = peekPlanIntent();
	const planCopy = planIntent
		? {
				name: PLANS[planIntent.plan].name,
				price: PLANS[planIntent.plan][planIntent.cadence]
			}
		: null;

	// A signed-out deep link (e.g. /cli-login?code=…) redirects here as
	// /?redirect_url=<that path>. Capture it at script-eval time — before any
	// redirect race can strip the URL — validated against open-redirect, and feed
	// it to BOTH the signed-in effect and Clerk so the two agree on one target.
	const redirectTarget = safeInternalPath(page.url.searchParams.get('redirect_url')) ?? '/dashboard';

	redirectIfSignedIn(redirectTarget);

	onMount(() => {
		if (authState.clerk && !authState.signedIn && host) mountAuth(authState.clerk, host, redirectTarget);
	});
</script>

{#if !authState.signedIn}
	{#if planCopy}
		<div class="mb-6 text-center">
			<h1 class="text-xl font-semibold tracking-tight">Create or sign in to continue</h1>
			<p class="mt-2 text-sm leading-6 text-muted-foreground">
				You're starting <strong class="font-medium text-foreground">{planCopy.name}</strong> at
				<strong class="font-medium text-foreground">{planCopy.price}</strong>.
				If this is your first subscription, it includes 14 days free.
			</p>
			<p class="mt-2 text-sm leading-6 text-muted-foreground">
				Create or sign in so your subscription is attached to your rbox account.
				Secure Stripe checkout is next.
			</p>
		</div>
	{:else}
		<p class="mb-6 text-center text-sm text-muted-foreground">
			Sign in to manage your devices, workspaces, and billing.
		</p>
	{/if}
	<div bind:this={host}></div>
	<!-- Clerk renders its bot/Smart-CAPTCHA challenge here when needed. -->
	<div id="clerk-captcha"></div>
{/if}
