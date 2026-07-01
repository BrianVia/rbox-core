<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { authState, requireAuth } from '$lib/auth.svelte';
	import { fetchAccountStatus, unlinkAccount, deleteAccount } from '$lib/api';
	import { errMsg } from '$lib/format';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import CheckIcon from '@lucide/svelte/icons/check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	let linked = $state<boolean | null>(null);
	let accountId = $state('');
	let error = $state('');
	let busy = $state(false);
	let confirming = $state(false);
	let done = $state('');

	// Danger zone — irreversible account deletion (design 37).
	let dangerOpen = $state(false);
	let deleteInput = $state('');
	let deleteBusy = $state(false);
	let deleteError = $state('');
	const ownerEmail = $derived(authState.clerk?.user?.primaryEmailAddress?.emailAddress ?? '');
	// The confirmation the server accepts: the owner's email OR the account id.
	const deleteArmed = $derived(
		deleteInput.trim().length > 0 &&
			(deleteInput.trim().toLowerCase() === ownerEmail.trim().toLowerCase() ||
				deleteInput.trim().toLowerCase() === accountId.trim().toLowerCase())
	);

	async function doDelete() {
		if (!authState.clerk || deleteBusy || !deleteArmed) return;
		deleteBusy = true;
		deleteError = '';
		try {
			await deleteAccount(authState.clerk, deleteInput.trim());
			// Account is tombstoned + this session is revoked server-side — sign out and leave.
			await authState.clerk.signOut();
			goto('/');
		} catch (e) {
			deleteError = errMsg(e);
			deleteBusy = false;
		}
	}

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

<header class="mb-8">
	<h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
	<p class="mt-1 text-sm text-muted-foreground">Manage how this dashboard connects to your account.</p>
</header>

{#if error}
	<div class="mb-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
		{error}
	</div>
{/if}

{#if done}
	<div class="rounded-xl border border-border bg-card p-6">
		<p class="flex items-center gap-2 text-base font-semibold">
			<CheckIcon class="size-5 text-success" /> Disconnected
		</p>
		<p class="mt-2 text-sm text-muted-foreground">
			This login now manages a fresh empty account. Your CLI devices, workspaces, and files were
			left untouched on the account you disconnected from.
		</p>
		<Button class="mt-4" onclick={() => goto('/dashboard')}>Back to overview</Button>
	</div>
{:else if linked === null}
	<div class="flex items-center gap-2 text-sm text-muted-foreground">
		<span class="size-2 animate-pulse rounded-full bg-primary"></span>
		Loading…
	</div>
{:else}
	<!-- Account connection — acts on the dashboard↔account MAPPING (design 22 §4). -->
	<section class="rounded-xl border border-border bg-card p-6">
		<h2 class="text-sm font-semibold">Account connection</h2>
		{#if linked}
			<p class="mt-2 text-sm">
				This dashboard login is connected to your rbox account
				<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{accountId}</code>.
			</p>
			<p class="mt-2 text-sm text-muted-foreground">
				Disconnecting signs this web login out of that account and gives it a fresh, empty one.
				<strong class="font-medium text-foreground">Your devices and files are untouched</strong> —
				this does not delete anything or revoke your CLI machines.
			</p>
			{#if confirming}
				<div class="mt-4 border-t border-border pt-4">
					<p class="text-sm">
						Disconnect this dashboard from
						<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{accountId}</code>?
					</p>
					<div class="mt-3 flex gap-2">
						<Button variant="destructive" size="sm" disabled={busy} onclick={doUnlink}>
							{busy ? 'Disconnecting…' : 'Yes, disconnect'}
						</Button>
						<Button variant="ghost" size="sm" disabled={busy} onclick={() => (confirming = false)}>
							Cancel
						</Button>
					</div>
				</div>
			{:else}
				<Button variant="outline" class="mt-4" onclick={() => (confirming = true)}>
					Disconnect this dashboard
				</Button>
			{/if}
		{:else}
			<p class="mt-2 text-sm text-muted-foreground">
				This login isn't connected to an rbox CLI account yet.
			</p>
			<Button class="mt-4" onclick={() => goto('/link')}>Link your CLI account</Button>
		{/if}
	</section>

	<!-- Danger zone — irreversible account + data deletion (design 37). -->
	<section class="mt-6 rounded-xl border border-destructive/30 bg-destructive/[0.02] p-6">
		<h2 class="flex items-center gap-2 text-sm font-semibold text-destructive">
			<TriangleAlertIcon class="size-4" /> Danger zone
		</h2>
		<p class="mt-2 text-sm">Delete this account and everything in it.</p>
		<p class="mt-2 text-sm text-muted-foreground">
			This permanently erases <strong class="font-medium text-foreground">account {accountId}</strong>:
			every device and web session, all workspaces and synced files, your billing/subscription, and
			this login. It cannot be undone after a short grace window. Your other accounts (if any) are
			untouched.
		</p>
		{#if !dangerOpen}
			<Button
				variant="outline"
				class="mt-4 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
				onclick={() => (dangerOpen = true)}
			>
				Delete account…
			</Button>
		{:else}
			<div class="mt-4 border-t border-destructive/20 pt-4">
				{#if deleteError}
					<div class="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
						{deleteError}
					</div>
				{/if}
				<Label for="del-confirm" class="text-sm font-normal">
					Type your account {ownerEmail ? 'email' : 'id'}
					<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{ownerEmail || accountId}</code>
					to confirm
				</Label>
				<Input
					id="del-confirm"
					class="mt-2 font-mono"
					autocomplete="off"
					bind:value={deleteInput}
					placeholder={ownerEmail || accountId}
					disabled={deleteBusy}
				/>
				<div class="mt-3 flex gap-2">
					<Button variant="destructive" disabled={!deleteArmed || deleteBusy} onclick={doDelete}>
						{deleteBusy ? 'Deleting…' : 'Permanently delete this account'}
					</Button>
					<Button
						variant="ghost"
						disabled={deleteBusy}
						onclick={() => {
							dangerOpen = false;
							deleteInput = '';
							deleteError = '';
						}}
					>
						Cancel
					</Button>
				</div>
			</div>
		{/if}
	</section>
{/if}
