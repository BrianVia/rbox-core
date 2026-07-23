<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { authState } from '$lib/auth.svelte';
	import { lookupDeviceAuth } from '$lib/api';
	import {
		fingerprintFromHash,
		approvalPageDescription,
		pendingApprovalPhase,
		submitDeviceApproval,
		verifyDeviceKeyConsent,
		type FingerprintFragment,
		type VerifiedDeviceKeyConsent
	} from '$lib/device-approval';
	import { errMsg } from '$lib/format';
	import { Button } from '$lib/components/ui/button';
	import PageHeader from '$lib/components/page-header.svelte';
	import Callout from '$lib/components/callout.svelte';
	import CheckIcon from '@lucide/svelte/icons/check';
	import LoaderIcon from '@lucide/svelte/icons/loader-circle';

	let { data } = $props();
	const code = $derived(data.code);
	const DOCS_URL = 'https://rbox.to/docs';
	const binding: FingerprintFragment = fingerprintFromHash(location.hash);
	const sendsKeys = binding.kind === 'present';

	// loading  → looking the code up
	// verify   → fragment present; fresh step-up + invisible binding check
	// confirm  → verified binding (or no-fragment auth-only); show Approve
	// mismatch → fragment was invalid or did not bind to the server-returned keys
	// approved → already approved/claimed, or we just approved it → "return to terminal"
	// missing  → 404 / no code (terminal — the code expired or never existed)
	// error    → transient lookup failure (retryable)
	type Phase = 'loading' | 'verify' | 'confirm' | 'mismatch' | 'approved' | 'missing' | 'error';

	let phase = $state<Phase>('loading');
	let label = $state<string | null>(null);
	let error = $state('');
	let busy = $state(false);
	let keyProof = $state<Extract<VerifiedDeviceKeyConsent, { status: 'match' }>['proof'] | null>(
		null
	);

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
				phase = pendingApprovalPhase(binding);
			}
		} catch (e) {
			error = errMsg(e);
			phase = 'error';
		}
	}

	async function verifyBinding() {
		if (!authState.clerk || busy || binding.kind !== 'present') return;
		busy = true;
		error = '';
		try {
			const result = await verifyDeviceKeyConsent(
				authState.clerk,
				code,
				binding.fingerprint
			);
			if (result.status === 'mismatch') {
				phase = 'mismatch';
				return;
			}
			keyProof = result.proof;
			phase = 'confirm';
		} catch (e) {
			error = errMsg(e);
		} finally {
			busy = false;
		}
	}

	async function approve() {
		if (!authState.clerk || busy) return;
		busy = true;
		error = '';
		try {
			await submitDeviceApproval(authState.clerk, code, binding, keyProof);
			phase = 'approved';
		} catch (e) {
			error = errMsg(e); // stays on the confirm card so the user can read why + retry
			if (binding.kind === 'present') {
				// Any key-consent retry gets a new ceremony and JWT rather than
				// reusing a proof the server may have rejected as stale.
				keyProof = null;
				phase = 'verify';
			}
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader
	title="Connect this machine"
	description={approvalPageDescription(phase, binding)}
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
		<p class="text-base font-medium">
			{#if label}
				Connect <strong class="font-medium">{label}</strong> to your rbox account?
			{:else}
				Connect this machine to your rbox account?
			{/if}
		</p>
		{#if sendsKeys}
			<p class="mt-3 text-sm leading-6 text-muted-foreground">
				Approving signs this machine in and sends it your encryption keys, so your files can
				open here.
			</p>
		{:else}
			<p class="mt-3 text-sm leading-6 text-muted-foreground">
				This link can sign the machine in, but it can’t send encryption keys. You’ll finish
				setting up encryption on the machine itself.
			</p>
		{/if}
		<div class="mt-5">
			<Button disabled={busy} onclick={approve}>
				{#if busy}
					<LoaderIcon class="size-4 animate-spin" />
					{sendsKeys ? 'Confirming…' : 'Approving…'}
				{:else}
					{sendsKeys
						? 'Approve and send this machine your encryption keys'
						: 'Approve sign-in'}
				{/if}
			</Button>
		</div>
	</div>
{:else if phase === 'verify'}
	<div class="rounded-xl border border-border bg-card p-6">
		<p class="text-base font-medium">
			{#if label}
				Connect <strong class="font-medium">{label}</strong> to your rbox account?
			{:else}
				Connect this machine to your rbox account?
			{/if}
		</p>
		<p class="mt-3 text-sm leading-6 text-muted-foreground">
			First, confirm it’s you. We’ll then make sure this request came from the same machine
			before you can approve it.
		</p>
		<div class="mt-5">
			<Button disabled={busy} onclick={verifyBinding}>
				{#if busy}
					<LoaderIcon class="size-4 animate-spin" /> Confirming…
				{:else}
					Continue
				{/if}
			</Button>
		</div>
	</div>
{:else if phase === 'mismatch'}
	<Callout class="mb-4">
		<p class="font-medium">This request doesn’t match the machine you started on.</p>
		<p class="mt-1 text-sm">
			Do not approve it. Return to that machine and run <code class="font-mono text-xs">rbox login</code>
			again.
		</p>
	</Callout>
	<Button variant="ghost" onclick={() => goto('/dashboard')}>Go to overview</Button>
{:else if phase === 'approved'}
	<div class="rounded-xl border border-border bg-card p-6">
		<p class="flex items-center gap-2 text-base font-semibold">
			<CheckIcon class="size-5 text-success" /> Machine approved
		</p>
		<p class="mt-2 text-sm text-muted-foreground">
			Return to this machine. <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">rbox login</code>
			will finish connecting it.
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
