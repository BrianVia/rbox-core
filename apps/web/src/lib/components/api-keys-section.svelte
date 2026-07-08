<script module lang="ts">
	const CREATE_CI_KEY_COMMAND = "rbox key create-ci --expires 90d --label \"<what it's for>\"";
	const JOIN_WITH_KEY_COMMAND = 'RBOX_KEY=… rbox setup --workspace=<name>';
	const AGENTS_DOCS_URL = 'https://rbox.to/docs/#agents';
	const API_KEYS_EMPTY_PITCH = 'Give your agents and CI your latest working tree — one key, one command';
	const API_KEY_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { authState } from '$lib/auth.svelte';
	import { fetchApiKeys, revokeApiKey, type ApiKey } from '$lib/api';
	import { friendlyErr } from '$lib/format';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import Callout from '$lib/components/callout.svelte';
	import CommandRow from '$lib/components/command-row.svelte';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import {
		apiKeyLastSeenLabel,
		apiKeyStatus,
		isApiKeyExpiringSoon
	} from './api-keys-section';

	let { class: className = '' }: { class?: string } = $props();

	let keys = $state<ApiKey[]>([]);
	let error = $state('');
	let loading = $state(true);
	let confirmId = $state<string | null>(null);
	let revoking = $state<string | null>(null);

	onMount(loadKeys);

	async function loadKeys() {
		if (!authState.clerk) return;
		try {
			keys = await fetchApiKeys(authState.clerk);
			error = '';
		} catch (e) {
			error = friendlyErr(e);
		} finally {
			loading = false;
		}
	}

	function labelFor(key: ApiKey): string {
		return key.label?.trim() || 'Unlabeled key';
	}

	function formatDate(ms: number): string {
		return API_KEY_DATE_FORMATTER.format(new Date(ms));
	}

	async function doRevoke(key: ApiKey) {
		if (!authState.clerk || revoking) return;
		revoking = key.deviceId;
		try {
			await revokeApiKey(authState.clerk, key.deviceId);
			await loadKeys();
			confirmId = null;
		} catch (e) {
			error = friendlyErr(e);
		} finally {
			revoking = null;
		}
	}
</script>

{#snippet instructions()}
	<div class="rounded-lg border border-border bg-card px-4 py-4">
		<div class="flex items-start gap-3">
			<span class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
				<KeyRoundIcon class="size-4" />
			</span>
			<div class="min-w-0 flex-1">
				<div class="text-sm font-medium">Create keys from a trusted machine</div>
				<p class="mt-0.5 text-xs text-muted-foreground">
					The dashboard can manage agent keys, but key material is issued by the CLI.
				</p>
				<CommandRow command={CREATE_CI_KEY_COMMAND} />
				<CommandRow command={JOIN_WITH_KEY_COMMAND} />
				<a
					href={AGENTS_DOCS_URL}
					class="mt-3 inline-flex text-xs font-medium text-primary underline-offset-4 hover:underline"
				>
					Read the agent setup guide
				</a>
			</div>
		</div>
	</div>
{/snippet}

<section class={className}>
	<div class="mb-3 flex flex-wrap items-end justify-between gap-3">
		<div>
			<h2 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Agent &amp; CI keys</h2>
			<p class="mt-1 max-w-prose text-xs text-muted-foreground">
				List and revoke the API keys your agents and automation use to sync this account.
			</p>
		</div>
		{#if !loading}
			<Button variant="ghost" size="sm" onclick={loadKeys} disabled={!!revoking}>Refresh</Button>
		{/if}
	</div>

	{#if error}
		<Callout class="mb-3">{error}</Callout>
	{/if}

	{#if loading}
		<div class="overflow-hidden rounded-lg border border-border">
			{#each [0, 1] as i (i)}
				<div class="grid gap-3 px-4 py-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_8rem_8rem_8rem_6rem_5rem] {i > 0 ? 'border-t border-border' : ''}">
					<Skeleton class="h-4 w-32" />
					<Skeleton class="h-4 w-44" />
					<Skeleton class="h-4 w-20" />
					<Skeleton class="h-4 w-20" />
					<Skeleton class="h-4 w-20" />
					<Skeleton class="h-5 w-16" />
					<Skeleton class="h-7 w-16" />
				</div>
			{/each}
		</div>
	{:else if keys.length === 0 && !error}
		<div class="rounded-lg border border-dashed border-border px-6 py-8">
			<p class="text-center text-sm font-medium">{API_KEYS_EMPTY_PITCH}</p>
			<div class="mt-5">
				{@render instructions()}
			</div>
		</div>
	{:else}
		{@render instructions()}

		<div class="mt-4 overflow-hidden rounded-lg border border-border">
			<div class="overflow-x-auto">
				<div class="min-w-full md:min-w-[64rem]">
					<div class="hidden grid-cols-[minmax(10rem,1.2fr)_minmax(12rem,1.4fr)_8rem_8rem_8rem_6rem_5rem] gap-3 border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
						<div>Label</div>
						<div>Prefix</div>
						<div>Created</div>
						<div>Last seen</div>
						<div>Expires</div>
						<div>Status</div>
						<div class="text-right">Action</div>
					</div>
					<div class="divide-y divide-border">
						{#each keys as key (key.deviceId)}
							{@const status = apiKeyStatus(key)}
							<div
								class="px-4 py-3.5 {key.revoked ? 'bg-muted/20 text-muted-foreground' : ''}"
							>
								{#if confirmId === key.deviceId}
									<div class="flex flex-col gap-3">
										<p class="text-sm">
											Revoke <strong class="font-medium">{labelFor(key)}</strong>
											<span class="font-mono text-xs text-muted-foreground">{key.displayPrefix}</span>,
											last seen {apiKeyLastSeenLabel(key.lastSeenAt)}? Agents using this key lose access
											immediately. Data already synced to them is not recalled.
										</p>
										<div class="flex gap-2">
											<Button
												variant="destructive"
												size="sm"
												disabled={revoking === key.deviceId}
												onclick={() => doRevoke(key)}
											>
												{revoking === key.deviceId ? 'Revoking…' : 'Revoke key'}
											</Button>
											<Button variant="ghost" size="sm" onclick={() => (confirmId = null)}>Cancel</Button>
										</div>
									</div>
								{:else}
									<div
										class="grid gap-x-3 gap-y-2 md:grid-cols-[minmax(10rem,1.2fr)_minmax(12rem,1.4fr)_8rem_8rem_8rem_6rem_5rem] md:items-center {key.revoked ? 'line-through decoration-muted-foreground/60' : ''}"
									>
										<div class="min-w-0">
											<div class="truncate text-sm font-medium">{labelFor(key)}</div>
											<div class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground md:hidden">
												{key.displayPrefix}
											</div>
										</div>
										<code class="hidden min-w-0 truncate whitespace-nowrap rounded bg-muted/60 px-2 py-1 font-mono text-xs md:block">
											{key.displayPrefix}
										</code>
										<div class="text-xs text-muted-foreground">
											<span class="font-medium text-foreground md:hidden">Created </span>{formatDate(key.createdAt)}
										</div>
										<div class="text-xs text-muted-foreground">
											<span class="font-medium text-foreground md:hidden">Last seen </span>{apiKeyLastSeenLabel(key.lastSeenAt)}
										</div>
										<div class="text-xs">
											<span
												class="rounded px-1.5 py-1 tabular {isApiKeyExpiringSoon(key) ? 'bg-warning/10 text-warning' : ''}"
											>
												<span class="font-medium text-foreground md:hidden">Expires </span>{formatDate(key.expiresAt)}
											</span>
										</div>
										<div>
											{#if status === 'active'}
												<Badge variant="outline" class="border-success/30 bg-success/10 text-success">Active</Badge>
											{:else if status === 'expired'}
												<Badge variant="destructive">Expired</Badge>
											{:else}
												<Badge variant="secondary">Revoked</Badge>
											{/if}
										</div>
										<div class="flex justify-start md:justify-end">
											{#if status === 'active'}
												<Button
													variant="ghost"
													size="sm"
													class="text-muted-foreground hover:text-destructive max-md:min-h-11"
													onclick={() => (confirmId = key.deviceId)}
												>
													Revoke
												</Button>
											{/if}
										</div>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			</div>
		</div>
	{/if}
</section>
