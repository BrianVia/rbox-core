<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { authState, requireAuth } from '$lib/auth.svelte';
	import { fetchAccountStatus, unlinkAccount } from '$lib/api';
	import { errMsg } from '$lib/format';

	let linked = $state<boolean | null>(null);
	let accountId = $state('');
	let error = $state('');
	let busy = $state(false);
	let confirming = $state(false);
	let done = $state('');

	requireAuth(); // not signed in → /

	onMount(loadStatus);

	async function loadStatus() {
		if (!authState.clerk) return;
		try {
			const s = await fetchAccountStatus(authState.clerk);
			linked = s.linked;
			accountId = s.accountId;
			error = '';
		} catch (e) {
			error = errMsg(e);
		}
	}

	async function doUnlink() {
		if (!authState.clerk || busy) return;
		busy = true;
		error = '';
		try {
			const fresh = await unlinkAccount(authState.clerk);
			done = fresh;
			confirming = false;
			await loadStatus(); // now linked === false against the fresh shell
		} catch (e) {
			error = errMsg(e);
		} finally {
			busy = false;
		}
	}
</script>

<header class="page-head">
	<button class="ghost back" onclick={() => goto('/dashboard')}>← Account</button>
	<h1>Settings</h1>
</header>

{#if error}
	<p class="error">{error}</p>
{/if}

{#if done}
	<div class="done-card">
		<p class="ok">✓ Disconnected.</p>
		<p class="faint small">
			This login now manages a fresh empty account. Your CLI devices, workspaces, and files were
			left untouched on the account you disconnected from.
		</p>
		<button class="primary" onclick={() => goto('/dashboard')}>Back to account</button>
	</div>
{:else if linked === null}
	<p class="muted">Loading…</p>
{:else}
	<section class="block">
		<h2>Account connection</h2>
		{#if linked}
			<!-- Identity action — distinct from device revoke (design 22 §4): this acts on
			     the dashboard↔account MAPPING, not on any device's keys. -->
			<p class="lead">
				This dashboard login is connected to your rbox account
				<code class="acct">{accountId}</code>.
			</p>
			<p class="faint small">
				Disconnecting signs this web login out of that account and gives it a fresh, empty one.
				<strong>Your devices and files are untouched</strong> — this does not delete anything or
				revoke your CLI machines.
			</p>
			{#if confirming}
				<div class="confirm">
					<p class="small">Disconnect this dashboard from <code>{accountId}</code>?</p>
					<div class="row">
						<button class="danger" disabled={busy} onclick={doUnlink}>
							{busy ? 'Disconnecting…' : 'Yes, disconnect'}
						</button>
						<button class="ghost" disabled={busy} onclick={() => (confirming = false)}>Cancel</button>
					</div>
				</div>
			{:else}
				<button class="danger" onclick={() => (confirming = true)}>Disconnect this dashboard</button>
			{/if}
		{:else}
			<p class="lead">This login isn’t connected to an rbox CLI account yet.</p>
			<button class="primary" onclick={() => goto('/link')}>Link your CLI account</button>
		{/if}
	</section>
{/if}

<style>
	.page-head {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 22px;
	}
	.back {
		font-size: 13px;
	}
	h1 {
		font-size: 20px;
		margin: 0;
	}
	.block {
		padding: 18px 20px;
		border-radius: 14px;
		border: 1px solid var(--border);
		background: rgba(255, 255, 255, 0.02);
	}
	h2 {
		font-size: 14px;
		font-weight: 600;
		color: var(--dim);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin: 0 0 12px;
	}
	.lead {
		margin: 0 0 8px;
	}
	.small {
		font-size: 13px;
	}
	.acct {
		font-family: ui-monospace, monospace;
		font-size: 13px;
	}
	.confirm {
		margin-top: 14px;
		padding-top: 14px;
		border-top: 1px solid var(--border);
	}
	.row {
		display: flex;
		gap: 8px;
		margin-top: 8px;
	}
	.done-card {
		padding: 18px 20px;
		border-radius: 14px;
		border: 1px solid var(--border);
		background: rgba(255, 255, 255, 0.02);
	}
	.ok {
		font-size: 18px;
		font-weight: 700;
		color: var(--accent-2, #36d6c3);
	}
	.danger {
		color: #ff6b6b;
		border-color: rgba(255, 107, 107, 0.4);
	}
	.danger:hover:not(:disabled) {
		border-color: rgba(255, 107, 107, 0.7);
	}
</style>
