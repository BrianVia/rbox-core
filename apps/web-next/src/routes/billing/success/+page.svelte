<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { authState, requireAuth } from '$lib/auth.svelte';
	import { fetchUsage } from '$lib/api';
	import { errMsg } from '$lib/format';

	// The plan flips on the Stripe subscription webhook, not on this browser return
	// (SF4). Poll usage until it leaves `free`, then show the dashboard — otherwise a
	// user would briefly see their old/free plan right after paying.
	let done = $state(false);
	let error = $state('');

	requireAuth(); // not signed in → /

	onMount(async () => {
		const clerk = authState.clerk;
		if (!clerk) return;
		const deadline = Date.now() + 25_000; // bounded wait for webhook
		while (Date.now() < deadline) {
			try {
				const u = await fetchUsage(clerk);
				if (u.plan && u.plan !== 'free') break;
			} catch (e) {
				// Terminal here — a failed request won't fix itself by polling.
				error = errMsg(e);
				break;
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
		done = true;
		goto('/dashboard');
	});
</script>

{#if error}
	<p class="error">{error}</p>
{/if}
{#if !done}
	<p class="muted">Finalizing your subscription…</p>
{:else}
	<p class="muted">Done — taking you to your dashboard.</p>
{/if}
