<script lang="ts">
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { authState, requireAuth } from '$lib/auth.svelte';
	import { startLink, pollLinkStatus, confirmLink, type LinkStatus } from '$lib/api';
	import { errMsg } from '$lib/format';

	type Phase = 'idle' | 'showing-code' | 'pending' | 'done';

	let phase = $state<Phase>('idle');
	let code = $state('');
	let pollKey = $state('');
	let proposed = $state<LinkStatus | null>(null);
	let linkedAccount = $state('');
	let error = $state('');
	let busy = $state(false);
	let poller: ReturnType<typeof setInterval> | null = null;

	requireAuth(); // not signed in → /

	onDestroy(() => {
		stopPolling();
		if (copiedTimer) clearTimeout(copiedTimer);
	});
	function stopPolling() {
		if (poller) clearInterval(poller);
		poller = null;
	}

	async function begin() {
		if (!authState.clerk || busy) return;
		busy = true;
		error = '';
		try {
			const r = await startLink(authState.clerk);
			code = r.code;
			pollKey = r.pollKey;
			phase = 'showing-code';
			startPolling();
		} catch (e) {
			error = errMsg(e);
		} finally {
			busy = false;
		}
	}

	function startPolling() {
		stopPolling();
		poller = setInterval(async () => {
			if (!authState.clerk) return;
			try {
				const s = await pollLinkStatus(authState.clerk, pollKey);
				if (s.status === 'pending') {
					proposed = s;
					phase = 'pending';
					stopPolling(); // wait for the user to approve the specific target
				} else if (s.status === 'expired') {
					error = 'This code expired before a terminal redeemed it. Start over.';
					phase = 'idle';
					stopPolling();
				}
			} catch (e) {
				error = errMsg(e);
				stopPolling();
			}
		}, 2500);
	}

	async function approve() {
		if (!authState.clerk || busy) return;
		busy = true;
		error = '';
		try {
			linkedAccount = await confirmLink(authState.clerk, pollKey);
			phase = 'done';
		} catch (e) {
			error = errMsg(e);
		} finally {
			busy = false;
		}
	}

	let copied = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;

	async function copyCode() {
		try {
			// Copy the whole command, not the bare code — the user is told to run
			// `rbox account link <code>`, so that's what the button should hand them.
			await navigator.clipboard.writeText(`rbox account link ${code}`);
			copied = true;
			if (copiedTimer) clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => (copied = false), 2000);
		} catch {
			/* clipboard blocked — the command is visible to copy manually */
		}
	}
</script>

<section class="wrap">
	<h1>Link your CLI account</h1>
	<p class="lead">
		Connect the <code>rbox</code> account on your machines to this web login, so the dashboard
		manages your real devices, workspaces, and billing.
	</p>

	{#if error}<p class="error">{error}</p>{/if}

	{#if phase === 'idle'}
		<p class="muted">
			You’ll get a one-time code to paste into a terminal that’s already signed in to your rbox
			account, then approve the match here.
		</p>
		<button class="primary" disabled={busy} onclick={begin}>Start linking</button>
		<button class="ghost" onclick={() => goto('/dashboard')}>Back to dashboard</button>
	{:else if phase === 'showing-code'}
		<ol class="steps">
			<li>
				Run this in a terminal signed in to your rbox account (an owner device):
				<div class="code-row">
					<code class="code">rbox account link {code}</code>
					<button class="ghost small" onclick={copyCode}>{copied ? 'Copied ✓' : 'Copy'}</button>
				</div>
			</li>
			<li>Come back here — we’ll show the account it proposes to link.</li>
		</ol>
		<p class="muted waiting">Waiting for a terminal to redeem the code…</p>
	{:else if phase === 'pending' && proposed}
		<div class="confirm-card">
			<p>
				A terminal wants to link this web login to account
				<strong class="fp">{proposed.fingerprint}</strong>.
			</p>
			<p class="muted small">Account <code>{proposed.pendingAccount}</code></p>
			<p class="muted small">
				Only approve if you started this from your own machine. Approving moves billing and device
				management to that account.
			</p>
			<div class="row">
				<button class="primary" disabled={busy} onclick={approve}>Approve &amp; link</button>
				<button class="ghost" disabled={busy} onclick={() => goto('/dashboard')}>Decline</button>
			</div>
		</div>
	{:else if phase === 'done'}
		<div class="done-card">
			<p class="ok">✓ Linked.</p>
			<p class="muted small">This login now manages account <code>{linkedAccount}</code>.</p>
			<button class="primary" onclick={() => goto('/dashboard')}>Go to dashboard</button>
		</div>
	{/if}
</section>

<style>
	.wrap {
		max-width: 560px;
	}
	h1 {
		font-size: 22px;
		margin-bottom: 6px;
	}
	.lead {
		color: var(--dim);
		margin-bottom: 18px;
	}
	.muted {
		color: var(--dim);
	}
	.small {
		font-size: 13px;
	}
	.waiting {
		margin-top: 14px;
	}
	.steps {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding-left: 18px;
		margin: 8px 0 4px;
	}
	.code-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 8px;
	}
	.code {
		flex: 1;
		display: block;
		padding: 10px 12px;
		border-radius: 10px;
		border: 1px solid var(--border);
		background: rgba(255, 255, 255, 0.03);
		font-family: ui-monospace, monospace;
		font-size: 13px;
		overflow-x: auto;
		white-space: nowrap;
	}
	.confirm-card,
	.done-card {
		padding: 18px 20px;
		border-radius: 14px;
		border: 1px solid var(--border);
		background: rgba(255, 255, 255, 0.02);
	}
	.fp {
		font-family: ui-monospace, monospace;
	}
	.ok {
		font-size: 18px;
		font-weight: 700;
		color: var(--accent-2, #36d6c3);
	}
	.row {
		display: flex;
		gap: 8px;
		margin-top: 16px;
	}
	button {
		margin-top: 12px;
		margin-right: 8px;
	}
	button.small {
		margin: 0;
	}
</style>
