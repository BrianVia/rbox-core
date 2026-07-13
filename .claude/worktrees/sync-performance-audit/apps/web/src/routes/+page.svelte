<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { authState, redirectIfSignedIn } from '$lib/auth.svelte';
	import { mountAuth } from '$lib/clerk';
	import { stashPlanIntent } from '$lib/plan-intent';

	let host = $state<HTMLDivElement>();

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

	redirectIfSignedIn(); // already signed in → /dashboard

	onMount(() => {
		if (authState.clerk && !authState.signedIn && host) mountAuth(authState.clerk, host);
	});
</script>

{#if !authState.signedIn}
	<p class="mb-6 text-center text-sm text-muted-foreground">
		Sign in to manage your devices, workspaces, and billing.
	</p>
	<div bind:this={host}></div>
	<!-- Clerk renders its bot/Smart-CAPTCHA challenge here when needed. -->
	<div id="clerk-captcha"></div>
{/if}
