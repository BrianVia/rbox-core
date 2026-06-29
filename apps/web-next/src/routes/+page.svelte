<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { authState } from '$lib/auth.svelte';
	import { mountAuth } from '$lib/clerk';

	let host = $state<HTMLDivElement>();

	// Already signed in → straight to the dashboard.
	$effect(() => {
		if (authState.signedIn) goto('/dashboard');
	});

	onMount(() => {
		if (authState.clerk && !authState.signedIn && host) mountAuth(authState.clerk, host);
	});
</script>

{#if !authState.signedIn}
	<div bind:this={host}></div>
	<!-- Clerk renders its bot/Smart-CAPTCHA challenge here when needed. -->
	<div id="clerk-captcha"></div>
{/if}
