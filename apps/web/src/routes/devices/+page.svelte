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
			const page = await fetchDevices(authState.clerk, {
				include: includeWeb ? 'all' : 'cli',
				cursor
			});
			devices = cursor ? [...devices, ...page.items] : page.items;
			devicesCursor = page.nextCursor;
			devicesError = '';
		} catch (e) {
			devicesError = friendly(errMsg(e));
		}
	}

	async function loadWorkspaces(cursor: string | null = null) {
		if (!authState.clerk) return;
		try {
			const page = await fetchWorkspaces(authState.clerk, { cursor });
			workspaces = cursor ? [...workspaces, ...page.items] : page.items;
			workspacesCursor = page.nextCursor;
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

	async function toggleWeb() {
		includeWeb = !includeWeb;
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

<header class="page-head">
	<button class="ghost back" onclick={() => goto('/dashboard')}>← Account</button>
	<h1>Devices &amp; workspaces</h1>
</header>

<!-- ── Devices ─────────────────────────────────────────────────────────────── -->
<section class="block">
	<div class="block-head">
		<h2>Devices</h2>
		<label class="toggle">
			<input type="checkbox" checked={includeWeb} onchange={toggleWeb} />
			<span>Show browser sessions</span>
		</label>
	</div>

	{#if devicesError}
		<p class="error">{devicesError}</p>
	{/if}

	{#if loading}
		<div class="skeleton"></div>
		<div class="skeleton"></div>
	{:else if devices.length === 0 && !devicesError}
		<div class="empty">
			{#if linked === false}
				<p>No devices here yet — this login isn’t connected to your rbox CLI account.</p>
				<button class="primary" onclick={() => goto('/link')}>Link your CLI account</button>
			{:else}
				<p>No devices yet. Set up rbox on a machine with the CLI to see it here.</p>
			{/if}
		</div>
	{:else}
		<ul class="rows">
			{#each devices as d (d.deviceId)}
				<li class="row" class:current={d.isCurrent}>
					<div class="row-main">
						<span class="label">{d.label ?? d.deviceId}</span>
						<span class="badges">
							<span class="badge kind-{d.kind}">{d.kind === 'cli' ? 'CLI' : 'browser'}</span>
							{#if d.isCurrent}<span class="badge current-badge">This device</span>{/if}
						</span>
						<span class="meta">Last seen {relativeTime(d.lastSeenAt)}</span>
					</div>
					<!-- Revoke is offered only for OTHER devices. The current session signs out
					     via Clerk (the menu), never a self-revoke that the SPA would re-mint. -->
					{#if !d.isCurrent}
						<div class="row-action">
							{#if confirmId === d.deviceId}
								<span class="confirm-copy"
									>Cut this device off the server? It can no longer sync. (This does
									<strong>not</strong> evict its encryption keys — key rotation isn’t available yet.)</span
								>
								<button
									class="danger small"
									disabled={revoking === d.deviceId}
									onclick={() => doRevoke(d.deviceId)}
								>
									{revoking === d.deviceId ? 'Revoking…' : 'Revoke access'}
								</button>
								<button class="ghost small" onclick={() => (confirmId = null)}>Cancel</button>
							{:else}
								<button class="ghost small" onclick={() => (confirmId = d.deviceId)}>Revoke</button>
							{/if}
						</div>
					{:else}
						<span class="self-note faint">Sign out from the account menu</span>
					{/if}
				</li>
			{/each}
		</ul>
		{#if devicesCursor}
			<button class="ghost show-more" onclick={() => loadDevices(devicesCursor)}>Show more</button>
		{/if}
	{/if}
</section>

<!-- ── Workspaces ──────────────────────────────────────────────────────────── -->
<section class="block">
	<div class="block-head">
		<h2>Workspaces</h2>
	</div>
	<p class="faint folder-note">
		rbox can’t see your files or folder contents — they’re end-to-end encrypted. A workspace
		shows only its <code>project</code> id unless someone opted in to a name at setup.
	</p>

	{#if workspacesError}
		<p class="error">{workspacesError}</p>
	{/if}

	{#if loading}
		<div class="skeleton"></div>
	{:else if workspaces.length === 0 && !workspacesError}
		<div class="empty">
			<p>No workspaces yet — your first <code>rbox</code> sync creates one.</p>
		</div>
	{:else}
		<ul class="rows">
			{#each workspaces as w (w.workspaceId)}
				<li class="row">
					<div class="row-main">
						<span class="label" class:mono={!w.name}>{w.name ?? w.projectId}</span>
						{#if w.name}
							<span class="meta">Name is visible to rbox; contents stay end-to-end encrypted · Created {relativeTime(w.createdAt)}</span>
						{:else}
							<span class="meta">Private — name lives only on your devices · Created {relativeTime(w.createdAt)}</span>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
		{#if workspacesCursor}
			<button class="ghost show-more" onclick={() => loadWorkspaces(workspacesCursor)}>Show more</button>
		{/if}
	{/if}
</section>

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
		margin-bottom: 26px;
	}
	.block-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
	}
	h2 {
		font-size: 14px;
		font-weight: 600;
		color: var(--dim);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin: 0;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		color: var(--dim);
		cursor: pointer;
	}
	.folder-note {
		font-size: 13px;
		margin: -4px 0 12px;
	}
	.rows {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0;
		padding: 0;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		padding: 14px 16px;
		border-radius: 12px;
		border: 1px solid var(--border);
		background: rgba(255, 255, 255, 0.02);
	}
	.row.current {
		border-color: rgba(124, 108, 255, 0.4);
	}
	.row-main {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.label {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.mono {
		font-family: ui-monospace, monospace;
		font-size: 14px;
	}
	.badges {
		display: flex;
		gap: 6px;
	}
	.badge {
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 2px 8px;
		border-radius: 999px;
		color: var(--dim);
		background: rgba(255, 255, 255, 0.06);
	}
	.kind-cli {
		color: var(--accent-2, #36d6c3);
		background: rgba(54, 214, 195, 0.12);
	}
	.current-badge {
		color: var(--accent, #7c6cff);
		background: rgba(124, 108, 255, 0.14);
	}
	.meta {
		font-size: 12.5px;
		color: var(--dim);
	}
	.row-action {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		justify-content: flex-end;
		max-width: 360px;
	}
	.confirm-copy {
		font-size: 12px;
		color: var(--dim);
	}
	.confirm-copy strong {
		color: var(--text);
	}
	.self-note {
		font-size: 12.5px;
	}
	.show-more {
		margin-top: 12px;
		font-size: 13px;
	}
	.empty {
		padding: 22px 16px;
		border-radius: 12px;
		border: 1px dashed var(--border);
		text-align: center;
		color: var(--dim);
	}
	.empty .primary {
		margin-top: 12px;
	}
	.skeleton {
		height: 56px;
		border-radius: 12px;
		margin-bottom: 8px;
		background: linear-gradient(
			90deg,
			rgba(255, 255, 255, 0.03),
			rgba(255, 255, 255, 0.06),
			rgba(255, 255, 255, 0.03)
		);
		background-size: 200% 100%;
		animation: shimmer 1.3s infinite;
	}
	@keyframes shimmer {
		to {
			background-position: -200% 0;
		}
	}
	.danger {
		color: #ff6b6b;
		border-color: rgba(255, 107, 107, 0.4);
	}
	.small {
		font-size: 12.5px;
		padding: 6px 10px;
	}
</style>
