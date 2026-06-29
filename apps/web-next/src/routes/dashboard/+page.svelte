<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { authState } from '$lib/auth.svelte';
	import { fetchUsage, startCheckout, openBillingPortal, type Usage } from '$lib/api';
	import { formatBytes } from '$lib/format';

	let usage = $state<Usage | null>(null);
	let error = $state('');
	let busy = $state(false);

	// Not signed in → back to sign-in.
	$effect(() => {
		if (!authState.signedIn) goto('/');
	});

	onMount(load);

	async function load() {
		if (!authState.clerk) return;
		try {
			usage = await fetchUsage(authState.clerk);
			error = '';
		} catch (e) {
			error =
				(e as Error).message === 'WEB_AUTH_NOT_ENABLED'
					? 'Web auth isn’t enabled on the API yet.'
					: (e as Error).message;
		}
	}

	async function checkout(plan: 'solo' | 'pro') {
		if (!authState.clerk || busy) return;
		busy = true;
		try {
			window.location.href = await startCheckout(authState.clerk, plan);
		} catch (e) {
			error = (e as Error).message;
			busy = false;
		}
	}

	async function portal() {
		if (!authState.clerk || busy) return;
		busy = true;
		try {
			window.location.href = await openBillingPortal(authState.clerk);
		} catch (e) {
			error = (e as Error).message;
			busy = false;
		}
	}

	async function signOut() {
		await authState.clerk?.signOut();
		goto('/');
	}

	const pct = $derived(
		usage && usage.storageCap ? Math.min(100, (usage.usedBytes / usage.storageCap) * 100) : 0
	);
</script>

{#if error}
	<p class="error">{error}</p>
{/if}

{#if usage}
	<section class="rows">
		<div class="row"><span class="faint">Plan</span><strong>{usage.plan}</strong></div>
		<div class="row">
			<span class="faint">Storage</span>
			<span
				>{formatBytes(usage.usedBytes)} / {usage.storageCap === null
					? '∞'
					: formatBytes(usage.storageCap)}</span
			>
		</div>
		<div class="bar"><div class="fill" style="width:{pct}%"></div></div>
		<div class="row">
			<span class="faint">Workspaces</span>
			<span>{usage.workspaces}{usage.workspaceCap === null ? '' : ` / ${usage.workspaceCap}`}</span>
		</div>
		<div class="row">
			<span class="faint">Version history</span>
			<span>{usage.retentionDays} day{usage.retentionDays === 1 ? '' : 's'}</span>
		</div>
	</section>

	<section class="plans">
		<button class="primary" disabled={busy} onclick={() => checkout('solo')}>Solo</button>
		<button class="primary" disabled={busy} onclick={() => checkout('pro')}>Pro</button>
		<button disabled title="Coming soon — per-seat billing not ready">Team — soon</button>
	</section>

	<section class="actions">
		<button disabled={busy} onclick={portal}>Manage billing</button>
		<button onclick={signOut}>Sign out</button>
	</section>
{:else if !error}
	<p class="muted">Loading account…</p>
{/if}

<style>
	.rows {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 24px;
	}
	.row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}
	.bar {
		height: 6px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.08);
		overflow: hidden;
	}
	.fill {
		height: 100%;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
	}
	.plans {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
		margin-bottom: 14px;
	}
	.actions {
		display: flex;
		gap: 8px;
	}
</style>
