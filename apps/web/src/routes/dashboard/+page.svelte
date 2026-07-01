<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import type { Clerk } from '@clerk/clerk-js';
	import { authState, requireAuth } from '$lib/auth.svelte';
	import { fetchUsage, fetchAccountStatus, startCheckout, openBillingPortal, type Usage } from '$lib/api';
	import { formatBytes, errMsg } from '$lib/format';

	let usage = $state<Usage | null>(null);
	// Whether this web login already manages a CLI account (design 21). Drives the
	// "Used the rbox CLI?" link nudge below — it only makes sense for logins that
	// AREN'T linked yet. `null` = unknown (not loaded / lookup failed) → nudge hidden,
	// so an already-linked user is never told to "link your account" again.
	let linked = $state<boolean | null>(null);
	let error = $state('');
	let busy = $state(false);

	requireAuth(); // not signed in → /

	onMount(load);

	async function load() {
		if (!authState.clerk) return;
		const clerk = authState.clerk;
		// Usage gates the page; link status only decides the nudge — fetch together,
		// but never let a status hiccup blank out the dashboard (allSettled, not all).
		const [u, s] = await Promise.allSettled([fetchUsage(clerk), fetchAccountStatus(clerk)]);
		if (u.status === 'fulfilled') {
			usage = u.value;
			error = '';
		} else {
			const m = errMsg(u.reason);
			error = m === 'WEB_AUTH_NOT_ENABLED' ? 'Web auth isn’t enabled on the API yet.' : m;
		}
		linked = s.status === 'fulfilled' ? s.value.linked : null;
	}

	// One busy-lock + error-capture + redirect path for every billing action.
	async function redirectVia(get: (c: Clerk) => Promise<string>) {
		if (!authState.clerk || busy) return;
		busy = true;
		try {
			window.location.href = await get(authState.clerk);
		} catch (e) {
			error = errMsg(e);
			busy = false;
		}
	}

	const checkout = (plan: 'solo' | 'pro') => redirectVia((c) => startCheckout(c, plan));
	const portal = () => redirectVia(openBillingPortal);

	async function signOut() {
		try {
			await authState.clerk?.signOut();
		} finally {
			goto('/'); // always leave, even if Clerk sign-out rejects
		}
	}

	// Display metadata per plan (matches apps/api/src/plans.ts).
	type Tier = 'free' | 'solo' | 'pro' | 'team';
	const PLAN: Record<Tier, { label: string; price: string }> = {
		free: { label: 'Free', price: '$0' },
		solo: { label: 'Solo', price: '$8/mo' },
		pro: { label: 'Pro', price: '$20/mo' },
		team: { label: 'Team', price: '$12/seat' }
	};

	const UPGRADES: {
		id: 'solo' | 'pro';
		label: string;
		price: string;
		features: string[];
		featured?: boolean;
	}[] = [
		{
			id: 'solo',
			label: 'Solo',
			price: '$8',
			features: ['50 GB storage', '30-day version history', 'Unlimited workspaces']
		},
		{
			id: 'pro',
			label: 'Pro',
			price: '$20',
			features: ['250 GB storage', '90-day version history', 'Advanced hydration'],
			featured: true
		}
	];

	// Getting-started commands — the exact, copy-pasteable onboarding a brand-new
	// login needs. Install one-liner is the canonical TOFU installer (scripts/install.sh
	// header; served from https://rbox.to/install.sh). `rbox setup` is the single
	// guided front door (src/cli/setup-cmd.ts). Kept as consts so the copy button
	// hands over byte-for-byte what's shown.
	const INSTALL_CMD = 'curl -fsSL https://rbox.to/install.sh | sh';
	const SETUP_CMD = 'rbox setup';

	// Copy-to-clipboard for the command blocks (mirrors /link's copy affordance).
	// `copied` holds the text of the just-copied command so only its button flips.
	let copied = $state('');
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;
	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = text;
			if (copiedTimer) clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => (copied = ''), 2000);
		} catch {
			/* clipboard blocked — the command is visible to copy manually */
		}
	}
	onDestroy(() => {
		if (copiedTimer) clearTimeout(copiedTimer);
	});

	const goLink = () => goto('/link');
	const goDevices = () => goto('/devices');
	const goSettings = () => goto('/settings');
	const plan = $derived((usage?.plan as Tier) ?? 'free');
	const isFree = $derived(plan === 'free');
	const info = $derived(PLAN[plan] ?? PLAN.free);
	const pct = $derived(
		usage && usage.storageCap ? Math.min(100, (usage.usedBytes / usage.storageCap) * 100) : 0
	);
</script>

{#if error}
	<p class="error">{error}</p>
{/if}

{#if usage}
	<!-- Plan hero — the clearest thing on the page: which tier you're on. -->
	<section class="hero" data-tier={plan}>
		<div class="hero-main">
			<span class="tier-badge">{info.label}</span>
			<span class="tier-status">{isFree ? 'Free plan' : 'Active subscription'}</span>
		</div>
		<span class="tier-price">{info.price}</span>
	</section>

	<!-- Usage -->
	<section class="usage">
		<div class="usage-storage">
			<div class="usage-line">
				<span class="faint">Storage</span>
				<span>
					<strong>{formatBytes(usage.usedBytes)}</strong>
					<span class="faint">
						of {usage.storageCap === null ? '∞' : formatBytes(usage.storageCap)}</span
					>
				</span>
			</div>
			<div class="bar"><div class="fill" style="width:{pct}%"></div></div>
		</div>
		<div class="usage-stats">
			<div class="stat">
				<span class="stat-num">{usage.workspaces}{usage.workspaceCap === null ? '' : `/${usage.workspaceCap}`}</span>
				<span class="faint">Workspaces</span>
			</div>
			<div class="stat">
				<span class="stat-num">{usage.retentionDays}d</span>
				<span class="faint">Version history</span>
			</div>
		</div>
	</section>

	<!-- Manage nav (design 22): devices/workspaces list + revoke live on their own
	     route; account unlink lives in Settings — deliberately separate surfaces. -->
	<nav class="manage-nav">
		<button class="nav-tile" onclick={goDevices}>
			<strong>Devices &amp; workspaces →</strong>
			<span class="faint">See your machines and sync roots; revoke access.</span>
		</button>
		<button class="nav-tile" onclick={goSettings}>
			<strong>Settings →</strong>
			<span class="faint">Disconnect this dashboard from your account.</span>
		</button>
	</nav>

	<!-- Discovery nudge (design 21 §6 / 17 §4.1): route CLI-first users to the
	     possession-proof link flow. NEVER auto-detect-and-bind (that's option C).
	     Shown ONLY to logins that aren't linked yet — an already-linked login is
	     managing its real account here, so re-prompting it to "link" is nonsense. -->
	{#if linked === false}
		<button class="link-nudge" onclick={goLink}>
			<span>Already using the <code>rbox</code> CLI? <strong>Link your account →</strong></span>
			<span class="faint">Connect your machines to manage their devices, workspaces &amp; billing here.</span>
		</button>
	{/if}

	<!-- Getting started (design 21/29): the CLI-first onboarding a brand-new web
	     login needs — install → `rbox setup` → link. Complements the link nudge
	     above, which assumes you ALREADY run the CLI; this covers the case where
	     you don't have rbox yet. Collapsible so it stays out of an established
	     user's way, but open by default until a CLI account is linked. -->
	<details class="getting-started" open={linked === false}>
		<summary>
			<span><strong>New to rbox?</strong> Set up the CLI in three steps</span>
			<span class="chev" aria-hidden="true">▾</span>
		</summary>
		<ol class="gs-steps">
			<li>
				<div class="gs-head">Install rbox</div>
				<p class="faint">One line — adds the <code>rbox</code> command on macOS or Linux.</p>
				<div class="code-row">
					<code class="code">{INSTALL_CMD}</code>
					<button class="ghost small" onclick={() => copy(INSTALL_CMD)}>
						{copied === INSTALL_CMD ? 'Copied ✓' : 'Copy'}
					</button>
				</div>
			</li>
			<li>
				<div class="gs-head">Run <code>rbox setup</code></div>
				<p class="faint">
					One command: creates your account, saves your recovery phrase, tracks a folder, and
					starts syncing in the background.
				</p>
				<div class="code-row">
					<code class="code">{SETUP_CMD}</code>
					<button class="ghost small" onclick={() => copy(SETUP_CMD)}>
						{copied === SETUP_CMD ? 'Copied ✓' : 'Copy'}
					</button>
				</div>
				<p class="gs-warn">
					Save your recovery phrase somewhere safe — it’s the only way back into your account. No
					one can reset it for you.
				</p>
			</li>
			<li>
				<div class="gs-head">Link this dashboard</div>
				<p class="faint">
					Connect your machines so you can manage devices, workspaces &amp; billing here.
				</p>
				<div class="code-row">
					<code class="code">rbox account link &lt;code&gt;</code>
				</div>
				<button class="ghost small gs-link" onclick={goLink}>Get your code →</button>
			</li>
		</ol>
	</details>

	{#if isFree}
		<!-- Free → upgrade. Cards make the choice + value obvious (vs bare buttons).
		     Paid users change plans via the portal, never a second checkout. -->
		<h2 class="section-title">Upgrade your plan</h2>
		<section class="cards">
			{#each UPGRADES as p}
				<article class="card" class:featured={p.featured}>
					{#if p.featured}<span class="rec">Most popular</span>{/if}
					<div class="card-name">{p.label}</div>
					<div class="card-price"><strong>{p.price}</strong><span class="faint">/mo</span></div>
					<ul class="card-features">
						{#each p.features as f}
							<li>{f}</li>
						{/each}
					</ul>
					<button class="primary" disabled={busy} onclick={() => checkout(p.id)}>
						Choose {p.label}
					</button>
				</article>
			{/each}
		</section>
		<p class="team-note faint">
			Need a team? <strong>Team plans</strong> with roles &amp; per-seat billing are coming soon.
		</p>
		<section class="footer">
			<button class="ghost" onclick={signOut}>Sign out</button>
		</section>
	{:else}
		<p class="manage-note faint">
			You’re all set on <strong>{info.label}</strong>. Upgrade, downgrade, or cancel anytime in the
			billing portal.
		</p>
		<section class="footer">
			<button class="primary" disabled={busy} onclick={portal}>Manage billing</button>
			<button class="ghost" onclick={signOut}>Sign out</button>
		</section>
	{/if}
{:else if !error}
	<p class="muted">Loading account…</p>
{/if}

<style>
	/* ---- plan hero ---- */
	.hero {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 18px 20px;
		border-radius: 14px;
		border: 1px solid var(--border);
		background: var(--bg-soft, rgba(255, 255, 255, 0.02));
		margin-bottom: 18px;
		position: relative;
		overflow: hidden;
	}
	.hero::before {
		content: '';
		position: absolute;
		inset: 0;
		background: radial-gradient(120% 140% at 0% 0%, var(--tier-glow, transparent), transparent 60%);
		pointer-events: none;
	}
	.hero[data-tier='pro'] {
		--tier-color: var(--accent);
		--tier-glow: rgba(124, 108, 255, 0.18);
		border-color: rgba(124, 108, 255, 0.4);
	}
	.hero[data-tier='solo'] {
		--tier-color: var(--accent-2);
		--tier-glow: rgba(54, 214, 195, 0.16);
		border-color: rgba(54, 214, 195, 0.35);
	}
	.hero[data-tier='team'] {
		--tier-color: #f0a868;
		--tier-glow: rgba(240, 168, 104, 0.16);
	}
	.hero[data-tier='free'] {
		--tier-color: var(--dim);
	}
	.hero-main {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.tier-badge {
		font-weight: 700;
		font-size: 18px;
		padding: 4px 12px;
		border-radius: 8px;
		color: #0a0a0f;
		background: var(--tier-color);
	}
	.hero[data-tier='free'] .tier-badge {
		color: var(--text);
		background: rgba(255, 255, 255, 0.08);
	}
	.tier-status {
		color: var(--dim);
		font-size: 14px;
	}
	.tier-price {
		font-weight: 700;
		font-size: 18px;
	}

	/* ---- usage ---- */
	.usage {
		padding: 16px 20px;
		border-radius: 14px;
		border: 1px solid var(--border);
		margin-bottom: 22px;
	}
	.usage-line {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 8px;
	}
	.bar {
		height: 8px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.07);
		overflow: hidden;
	}
	.fill {
		height: 100%;
		border-radius: 999px;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		transition: width 0.4s ease;
	}
	.usage-stats {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
	}
	.stat {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.stat-num {
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.01em;
	}
	.stat .faint {
		font-size: 13px;
	}

	/* ---- upgrade cards ---- */
	.section-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--dim);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 12px;
	}
	.cards {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	.card {
		position: relative;
		display: flex;
		flex-direction: column;
		padding: 18px;
		border-radius: 14px;
		border: 1px solid var(--border);
		background: rgba(255, 255, 255, 0.02);
	}
	.card.featured {
		border-color: rgba(124, 108, 255, 0.5);
		background: linear-gradient(180deg, rgba(124, 108, 255, 0.1), transparent 70%);
	}
	.rec {
		position: absolute;
		top: -9px;
		left: 18px;
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #fff;
		background: linear-gradient(135deg, var(--accent), var(--accent-2));
		padding: 3px 9px;
		border-radius: 999px;
	}
	.card-name {
		font-weight: 600;
		color: var(--dim);
	}
	.card-price {
		margin: 4px 0 14px;
		font-size: 26px;
		letter-spacing: -0.02em;
	}
	.card-price .faint {
		font-size: 14px;
		font-weight: 400;
	}
	.card-features {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0 0 18px;
		flex: 1;
	}
	.card-features li {
		font-size: 13.5px;
		color: var(--dim);
		padding-left: 18px;
		position: relative;
	}
	.card-features li::before {
		content: '✓';
		position: absolute;
		left: 0;
		color: var(--accent-2);
		font-weight: 700;
	}
	.team-note {
		margin-top: 14px;
		font-size: 13.5px;
		text-align: center;
	}

	.manage-note {
		font-size: 14px;
		margin-bottom: 18px;
	}
	.manage-note strong,
	.team-note strong {
		color: var(--text);
	}

	/* ---- manage nav ---- */
	.manage-nav {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
		margin-bottom: 14px;
	}
	.nav-tile {
		display: flex;
		flex-direction: column;
		gap: 3px;
		text-align: left;
		padding: 14px 16px;
		border-radius: 12px;
		border: 1px solid var(--border);
		background: rgba(255, 255, 255, 0.02);
		cursor: pointer;
		transition: border-color 0.2s ease;
	}
	.nav-tile:hover {
		border-color: rgba(124, 108, 255, 0.45);
	}
	.nav-tile .faint {
		font-size: 12.5px;
	}

	/* ---- link nudge ---- */
	.link-nudge {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		text-align: left;
		padding: 14px 16px;
		margin-bottom: 22px;
		border-radius: 12px;
		border: 1px solid var(--border);
		background: rgba(255, 255, 255, 0.02);
		cursor: pointer;
		transition: border-color 0.2s ease;
	}
	.link-nudge:hover {
		border-color: rgba(124, 108, 255, 0.45);
	}
	.link-nudge strong {
		color: var(--accent, #7c6cff);
	}
	.link-nudge .faint {
		font-size: 13px;
	}

	/* ---- getting started ---- */
	.getting-started {
		margin-bottom: 22px;
		border-radius: 12px;
		border: 1px solid var(--border);
		background: rgba(255, 255, 255, 0.02);
		overflow: hidden;
	}
	.getting-started > summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 14px 16px;
		cursor: pointer;
		list-style: none;
		user-select: none;
		font-size: 14px;
	}
	.getting-started > summary::-webkit-details-marker {
		display: none;
	}
	.getting-started > summary strong {
		color: var(--accent, #7c6cff);
	}
	.getting-started .chev {
		color: var(--dim);
		transition: transform 0.2s ease;
	}
	.getting-started[open] .chev {
		transform: rotate(180deg);
	}
	.gs-steps {
		margin: 0;
		padding: 2px 20px 18px 40px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	.gs-steps li {
		color: var(--dim);
	}
	.gs-head {
		font-weight: 600;
		color: var(--text);
		margin-bottom: 4px;
	}
	.gs-steps p {
		margin: 0 0 8px;
		font-size: 13px;
	}
	.gs-warn {
		color: #f0a868;
		font-size: 12.5px !important;
		margin: 8px 0 0 !important;
	}
	.gs-link {
		margin-top: 4px;
	}
	.code-row {
		display: flex;
		align-items: center;
		gap: 8px;
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
		color: var(--text);
		overflow-x: auto;
		white-space: nowrap;
	}
	.small {
		font-size: 13px;
		flex-shrink: 0;
	}

	/* ---- footer ---- */
	.footer {
		display: flex;
		gap: 8px;
		margin-top: 22px;
		padding-top: 18px;
		border-top: 1px solid var(--border);
	}
	.footer .primary {
		flex: 1;
	}
</style>
