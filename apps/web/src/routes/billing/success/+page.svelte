<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { authState, requireAuth } from '$lib/auth.svelte';
	import { fetchUsage } from '$lib/api';

	// The plan flips on the Stripe subscription webhook, not on this browser return
	// (SF4). Poll usage until it leaves `free`, then hand off to the dashboard — which
	// owns error display, so any failure here just breaks the poll and lets it show.
	let done = $state(false);

	requireAuth(); // not signed in → /

	onMount(async () => {
		const clerk = authState.clerk;
		if (clerk) {
			const deadline = Date.now() + 25_000; // bounded wait for webhook
			while (Date.now() < deadline) {
				try {
					const u = await fetchUsage(clerk);
					if (u.plan && u.plan !== 'free') break;
				} catch {
					break; // terminal — the dashboard will surface the real error
				}
				await new Promise((r) => setTimeout(r, 2000));
			}
		}
		done = true;
		goto('/dashboard');
	});
</script>

{#if !done}
	<p class="muted">Finalizing your subscription…</p>
{/if}
