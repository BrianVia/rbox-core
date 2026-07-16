<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { authState } from '$lib/auth.svelte';
	import { lookupDeviceAuth, approveDeviceAuth } from '$lib/api';
	import { errMsg } from '$lib/format';
	import { Button } from '$lib/components/ui/button';
	import PageHeader from '$lib/components/page-header.svelte';
	import Callout from '$lib/components/callout.svelte';
	import CheckIcon from '@lucide/svelte/icons/check';
	import LoaderIcon from '@lucide/svelte/icons/loader-circle';

	let { data } = $props();
	const code = $derived(data.code);
	const DOCS_URL = 'https://rbox.to/docs';

	// loading  → looking the code up
	// confirm  → pending code; show the device asking + the Approve button
	// approved → already approved/claimed, or we just approved it → "return to terminal"
	// missing  → 404 / no code (terminal — the code expired or never existed)
	// error    → transient lookup failure (retryable)
	type Phase = 'loading' | 'confirm' | 'approved' | 'missing' | 'error';

	let phase = $state<Phase>('loading');
	let label = $state<string | null>(null);
	let error = $state('');
	let busy = $state(false);

	onMount(load);

	async function load() {
		if (!code) {
			phase = 'missing';
			return;
		}
		error = '';
		phase = 'loading';
		try {
			const res = await lookupDeviceAuth(code);
			if (!res) {
				phase = 'missing';
			} else if (res.status === 'approved' || res.status === 'claimed') {
				phase = 'approved';
			} else {
				label = res.label;
				phase = 'confirm';
			}
		} catch (e) {
			error = errMsg(e);
			phase = 'error';
		}
	}

	async function approve() {
		if (!authState.clerk || busy) return;
		busy = true;
		error = '';
		try {
			await approveDeviceAuth(authState.clerk, code);
			phase = 'approved';
		} catch (e) {
			error = errMsg(e); // stays on the confirm card so the user can read why + retry
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader
	title="Approve CLI login"
	description="A device running `rbox login` is asking to sign in to your rbox account. Confirm it here."
/>

<a href={DOCS_URL} class="mb-4 inline-flex text-xs font-medium text-primary underline-offset-4 hover:underline">
	Read the rbox docs
</a>

{#if error && phase !== 'error'}
	<Callout class="mb-4">{error}</Callout>
{/if}

{#if phase === 'loading'}
	<p class="flex items-center gap-2 text-sm text-muted-foreground">
		<LoaderIcon class="size-4 animate-spin" /> Checking this login…
	</p>
{:else if phase === 'confirm'}
	<div class="rounded-xl border border-border bg-card p-6">
		<p class="text-sm">
			{#if label}
				A device wants to sign in to your rbox account as
				<strong class="font-mono font-medium">{label}</strong>.
			{:else}
				A device wants to sign in to your rbox account.
			{/if}
		</p>
		<p class="mt-2 text-sm text-muted-foreground">
			Confirmation code
			<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{code}</code>
			— it should match the one shown in your terminal.
		</p>
		<p class="mt-3 text-sm text-muted-foreground">
			This confirmation code is different from a pairing token: it authorizes the device, while
			a pairing token also carries encryption.
		</p>
		<p class="mt-2 text-sm text-muted-foreground">
			Approving authorizes this device to reach your account. It does <em>not</em> unlock your
			encrypted files — you'll still finish pairing on the device itself.
		</p>
		<div class="mt-5">
			<Button disabled={busy} onclick={approve}>Approve login</Button>
		</div>
	</div>
{:else if phase === 'approved'}
	<div class="rounded-xl border border-border bg-card p-6">
		<p class="flex items-center gap-2 text-base font-semibold">
			<CheckIcon class="size-5 text-success" /> Login approved
		</p>
		<p class="mt-2 text-sm text-muted-foreground">
			Return to your terminal — <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">rbox login</code>
			will finish connecting this device within a few seconds.
		</p>
		<Button class="mt-4" variant="ghost" onclick={() => goto('/dashboard')}>Go to overview</Button>
	</div>
{:else if phase === 'missing'}
	<div class="rounded-xl border border-border bg-card p-6">
		<p class="text-base font-semibold">Code expired or not found</p>
		<p class="mt-2 text-sm text-muted-foreground">
			This code has expired or doesn't exist. Run
			<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">rbox login</code>
			again to get a fresh one.
		</p>
		<Button class="mt-4" variant="ghost" onclick={() => goto('/dashboard')}>Go to overview</Button>
	</div>
{:else if phase === 'error'}
	<Callout class="mb-4">{error}</Callout>
	<Button disabled={busy} onclick={load}>Try again</Button>
{/if}
