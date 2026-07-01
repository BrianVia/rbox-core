<script lang="ts">
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { authState, requireAuth } from '$lib/auth.svelte';
	import { startLink, pollLinkStatus, confirmLink, type LinkStatus } from '$lib/api';
	import { errMsg } from '$lib/format';
	import { Button } from '$lib/components/ui/button';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import LoaderIcon from '@lucide/svelte/icons/loader-circle';

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

<header class="mb-6">
	<h1 class="text-2xl font-semibold tracking-tight">Link your CLI account</h1>
	<p class="mt-1 max-w-prose text-sm text-muted-foreground">
		Connect the <code class="rounded bg-muted px-1 py-0.5">rbox</code> account on your machines to this
		web login, so the dashboard manages your real devices, workspaces, and billing.
	</p>
</header>

{#if error}
	<div class="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
		{error}
	</div>
{/if}

{#if phase === 'idle'}
	<p class="text-sm text-muted-foreground">
		You'll get a one-time code to paste into a terminal that's already signed in to your rbox account,
		then approve the match here.
	</p>
	<div class="mt-5 flex gap-2">
		<Button disabled={busy} onclick={begin}>Start linking</Button>
		<Button variant="ghost" onclick={() => goto('/dashboard')}>Back to overview</Button>
	</div>
{:else if phase === 'showing-code'}
	<ol class="flex flex-col gap-5">
		<li class="grid grid-cols-[1.5rem_1fr] gap-x-3">
			<span class="grid size-6 place-items-center rounded-full bg-secondary text-xs font-semibold tabular">1</span>
			<div class="min-w-0">
				<p class="text-sm">Run this in a terminal signed in to your rbox account (an owner device):</p>
				<div class="mt-2 flex items-center gap-2">
					<code class="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted/50 px-3 py-2 font-mono text-xs whitespace-nowrap">
						rbox account link {code}
					</code>
					<Button variant="outline" size="sm" class="shrink-0" onclick={copyCode}>
						{#if copied}
							<CheckIcon class="size-3.5 text-success" /> Copied
						{:else}
							<CopyIcon class="size-3.5" /> Copy
						{/if}
					</Button>
				</div>
			</div>
		</li>
		<li class="grid grid-cols-[1.5rem_1fr] gap-x-3">
			<span class="grid size-6 place-items-center rounded-full bg-secondary text-xs font-semibold tabular">2</span>
			<p class="text-sm">Come back here — we'll show the account it proposes to link.</p>
		</li>
	</ol>
	<p class="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
		<LoaderIcon class="size-4 animate-spin" /> Waiting for a terminal to redeem the code…
	</p>
{:else if phase === 'pending' && proposed}
	<div class="rounded-xl border border-border bg-card p-6">
		<p class="text-sm">
			A terminal wants to link this web login to account
			<strong class="font-mono font-medium">{proposed.fingerprint}</strong>.
		</p>
		<p class="mt-1 text-sm text-muted-foreground">
			Account <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{proposed.pendingAccount}</code>
		</p>
		<p class="mt-3 text-sm text-muted-foreground">
			Only approve if you started this from your own machine. Approving moves billing and device
			management to that account.
		</p>
		<div class="mt-5 flex gap-2">
			<Button disabled={busy} onclick={approve}>Approve &amp; link</Button>
			<Button variant="ghost" disabled={busy} onclick={() => goto('/dashboard')}>Decline</Button>
		</div>
	</div>
{:else if phase === 'done'}
	<div class="rounded-xl border border-border bg-card p-6">
		<p class="flex items-center gap-2 text-base font-semibold">
			<CheckIcon class="size-5 text-success" /> Linked
		</p>
		<p class="mt-2 text-sm text-muted-foreground">
			This login now manages account
			<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{linkedAccount}</code>.
		</p>
		<Button class="mt-4" onclick={() => goto('/dashboard')}>Go to overview</Button>
	</div>
{/if}
