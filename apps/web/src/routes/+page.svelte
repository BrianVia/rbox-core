<script lang="ts">
	import { onMount } from 'svelte';
	import { authState, redirectIfSignedIn } from '$lib/auth.svelte';
	import { mountAuth } from '$lib/clerk';

	let host = $state<HTMLDivElement>();

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
