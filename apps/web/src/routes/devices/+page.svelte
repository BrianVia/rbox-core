<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { authState, requireAuth } from '$lib/auth.svelte';
	import {
		fetchDevices,
		fetchWorkspaces,
		fetchAccountStatus,
		revokeDevice,
		type Device,
		type Workspace
	} from '$lib/api';
	import { relativeTime, errMsg } from '$lib/format';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import PageHeader from '$lib/components/page-header.svelte';
	import Callout from '$lib/components/callout.svelte';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import FolderIcon from '@lucide/svelte/icons/folder';

	let devices = $state<Device[]>([]);
	let devicesCursor = $state<string | null>(null);
	let devicesError = $state('');
	let includeWeb = $state(false);

	let workspaces = $state<Workspace[]>([]);
	let workspacesCursor = $state<string | null>(null);
	let workspacesError = $state('');

	let linked = $state<boolean | null>(null);
	let loading = $state(true);
	let revoking = $state<string | null>(null);
	let confirmId = $state<string | null>(null);

	requireAuth(); // not signed in → /

	onMount(async () => {
		await Promise.all([loadDevices(), loadWorkspaces()]);
		// `linked` only drives the EMPTY state's "link your CLI account" nudge, so only
		// pay for /v1/account/status when there are no devices to show.
		if (devices.length === 0) await loadStatus();
		loading = false;
	});

	function friendly(m: string): string {
		return m === 'WEB_AUTH_NOT_ENABLED' ? 'Web auth isn’t enabled on the API yet.' : m;
	}

	async function loadDevices(cursor: string | null = null) {
		if (!authState.clerk) return;
		try {
			const pageRes = await fetchDevices(authState.clerk, {
				include: includeWeb ? 'all' : 'cli',
				cursor
			});
			devices = cursor ? [...devices, ...pageRes.items] : pageRes.items;
			devicesCursor = pageRes.nextCursor;
			devicesError = '';
		} catch (e) {
			devicesError = friendly(errMsg(e));
		}
	}

	async function loadWorkspaces(cursor: string | null = null) {
		if (!authState.clerk) return;
		try {
			const pageRes = await fetchWorkspaces(authState.clerk, { cursor });
			workspaces = cursor ? [...workspaces, ...pageRes.items] : pageRes.items;
			workspacesCursor = pageRes.nextCursor;
			workspacesError = '';
		} catch (e) {
			workspacesError = friendly(errMsg(e));
		}
	}

	async function loadStatus() {
		if (!authState.clerk) return;
		try {
			linked = (await fetchAccountStatus(authState.clerk)).linked;
		} catch {
			linked = null; // non-fatal; just hides the link nudge
		}
	}

	// Reset + reload when the browser-sessions filter flips. Take the new value
	// straight from the callback so we don't depend on bind ordering vs the reload.
	async function onToggleWeb(checked: boolean) {
		includeWeb = checked;
		devices = [];
		devicesCursor = null;
		await loadDevices();
	}

	async function doRevoke(id: string) {
		if (!authState.clerk || revoking) return;
		revoking = id;
		try {
			await revokeDevice(authState.clerk, id);
			confirmId = null;
			await loadDevices(); // reload from the top (the row drops out; resets the cursor)
		} catch (e) {
			devicesError = errMsg(e);
		} finally {
			revoking = null;
		}
	}
</script>

{#snippet deviceAction(d: Device)}
	<!-- Revoke is offered only for OTHER devices. The current session signs out
	     via the account menu, never a self-revoke the SPA would re-mint. -->
	{#if !d.isCurrent}
		<Button
			variant="ghost"
			size="sm"
			class="shrink-0 text-muted-foreground hover:text-destructive max-md:min-h-11"
			onclick={() => (confirmId = d.deviceId)}
		>
			Revoke
		</Button>
	{:else}
		<span class="shrink-0 text-xs text-muted-foreground">Sign out from the menu</span>
	{/if}
{/snippet}

<PageHeader
	title="Devices & workspaces"
	description="The machines connected to your account and the workspaces they sync."
/>

<!-- ── Devices ─────────────────────────────────────────────────────────────── -->
<section class="mb-10">
	<div class="mb-3 flex items-center justify-between gap-4">
		<h2 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Devices</h2>
		<label class="flex items-center gap-2 text-sm text-muted-foreground select-none">
			<Switch checked={includeWeb} onCheckedChange={onToggleWeb} aria-label="Show browser sessions" />
			Show browser sessions
		</label>
	</div>

	{#if devicesError}
		<Callout class="mb-3">{devicesError}</Callout>
	{/if}

	{#if loading}
		<div class="overflow-hidden rounded-lg border border-border">
			{#each [0, 1] as i (i)}
				<div class="flex items-center justify-between px-4 py-4 {i > 0 ? 'border-t border-border' : ''}">
					<div class="space-y-2">
						<Skeleton class="h-4 w-40" />
						<Skeleton class="h-3 w-24" />
					</div>
					<Skeleton class="h-8 w-16" />
				</div>
			{/each}
		</div>
	{:else if devices.length === 0 && !devicesError}
		<div class="rounded-lg border border-dashed border-border px-6 py-10 text-center">
			{#if linked === false}
				<p class="text-sm text-muted-foreground">
					No devices here yet — this login isn't connected to your rbox CLI account.
				</p>
				<Button class="mt-4" onclick={() => goto('/link')}>Link your CLI account</Button>
			{:else}
				<p class="text-sm text-muted-foreground">
					No devices yet. Set up rbox on a machine with the CLI to see it here.
				</p>
			{/if}
		</div>
	{:else}
		<div class="divide-y divide-border overflow-hidden rounded-lg border border-border">
			{#each devices as d (d.deviceId)}
				<div class="px-4 py-3.5 {d.isCurrent ? 'bg-primary/[0.03]' : ''}">
					{#if confirmId === d.deviceId}
						<!-- Inline confirm (no modal): revoke cuts sync but does NOT evict keys. -->
						<div class="flex flex-col gap-3">
							<p class="text-sm">
								Cut <strong class="font-medium">{d.label ?? d.deviceId}</strong> off the server? It can no
								longer sync. This does <strong class="font-medium">not</strong> evict its encryption keys — key
								rotation isn't available yet.
							</p>
							<div class="flex gap-2">
								<Button
									variant="destructive"
									size="sm"
									disabled={revoking === d.deviceId}
									onclick={() => doRevoke(d.deviceId)}
								>
									{revoking === d.deviceId ? 'Revoking…' : 'Revoke access'}
								</Button>
								<Button variant="ghost" size="sm" onclick={() => (confirmId = null)}>Cancel</Button>
							</div>
						</div>
					{:else}
						<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
							<div class="flex min-w-0 items-start gap-3 sm:items-center">
								<span class="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
									<MonitorIcon class="size-4" />
								</span>
								<div class="min-w-0 max-sm:flex-1">
									<div class="flex items-center gap-x-2 gap-y-1 max-sm:flex-wrap">
										<span class="truncate text-sm font-medium max-sm:min-w-0 max-sm:basis-full">
											{d.label ?? d.deviceId}
										</span>
										<Badge variant="outline" class="px-1.5 py-0 text-[10px] uppercase">
											{d.kind === 'cli' ? 'CLI' : 'Browser'}
										</Badge>
										{#if d.isCurrent}
											<Badge variant="secondary" class="px-1.5 py-0 text-[10px]">This device</Badge>
										{/if}
									</div>
									<div class="mt-0.5 text-xs text-muted-foreground">
										Last seen {relativeTime(d.lastSeenAt)}
									</div>
									<div class="mt-2 flex sm:hidden">
										{@render deviceAction(d)}
									</div>
								</div>
							</div>
							<div class="hidden shrink-0 sm:block">
								{@render deviceAction(d)}
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
		{#if devicesCursor}
			<Button variant="ghost" size="sm" class="mt-3" onclick={() => loadDevices(devicesCursor)}>
				Show more
			</Button>
		{/if}
	{/if}
</section>

<!-- ── Workspaces ──────────────────────────────────────────────────────────── -->
<section>
	<h2 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Workspaces</h2>
	<p class="mb-3 max-w-prose text-xs text-muted-foreground">
		rbox can't see your files or folder contents — they're end-to-end encrypted. A workspace shows
		only its <code class="rounded bg-muted px-1 py-0.5">project</code> id unless someone opted in to a
		name at setup.
	</p>

	{#if workspacesError}
		<Callout class="mb-3">{workspacesError}</Callout>
	{/if}

	{#if loading}
		<div class="overflow-hidden rounded-lg border border-border px-4 py-4">
			<Skeleton class="h-4 w-32" />
			<Skeleton class="mt-2 h-3 w-56" />
		</div>
	{:else if workspaces.length === 0 && !workspacesError}
		<div class="rounded-lg border border-dashed border-border px-6 py-10 text-center">
			<p class="text-sm text-muted-foreground">
				No workspaces yet — your first <code class="rounded bg-muted px-1 py-0.5">rbox</code> sync creates
				one.
			</p>
		</div>
	{:else}
		<div class="divide-y divide-border overflow-hidden rounded-lg border border-border">
			{#each workspaces as w (w.workspaceId)}
				<div class="flex items-center gap-3 px-4 py-3.5">
					<span class="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
						<FolderIcon class="size-4" />
					</span>
					<div class="min-w-0">
						<span class="block truncate text-sm font-medium {w.name ? '' : 'font-mono'}">
							{w.name ?? w.projectId}
						</span>
						<span class="mt-0.5 block text-xs text-muted-foreground">
							{#if w.name}
								Name is visible to rbox; contents stay end-to-end encrypted · Created {relativeTime(w.createdAt)}
							{:else}
								Private — name lives only on your devices · Created {relativeTime(w.createdAt)}
							{/if}
						</span>
					</div>
				</div>
			{/each}
		</div>
		{#if workspacesCursor}
			<Button variant="ghost" size="sm" class="mt-3" onclick={() => loadWorkspaces(workspacesCursor)}>
				Show more
			</Button>
		{/if}
	{/if}
</section>
