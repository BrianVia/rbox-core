<script lang="ts">
	import { onMount } from 'svelte';
	import { getClerk } from '$lib/clerk';
	import { clearStaleTokens } from '$lib/api';
	import { setClerk, syncSignedIn } from '$lib/auth.svelte';
	import { errMsg } from '$lib/format';
	import '../app.css';

	let { children } = $props();
	let ready = $state(false);
	let fatal = $state('');

	onMount(async () => {
		try {
			const clerk = await getClerk();
			setClerk(clerk);
			clearStaleTokens(clerk.session?.id ?? null);
			// On any Clerk session/user change: drop tokens that aren't the live
			// session (B3) and re-sync signed-in state for the router.
			clerk.addListener(() => {
				clearStaleTokens(clerk.session?.id ?? null);
				syncSignedIn();
			});
			ready = true;
		} catch (e) {
			fatal = errMsg(e);
		}
	});
</script>

<svelte:head>
	<title>rbox — account & billing</title>
</svelte:head>

<main class="shell">
	<header>
		<span class="logo">rbox</span>
		<span class="tag">account &amp; billing</span>
	</header>
	{#if fatal}
		<p class="error">Couldn’t start: {fatal}</p>
	{:else if ready}
		{@render children()}
	{:else}
		<p class="muted">Loading…</p>
	{/if}
</main>
