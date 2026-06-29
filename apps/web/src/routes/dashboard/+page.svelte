<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { Clerk } from '@clerk/clerk-js';
	import { authState, requireAuth } from '$lib/auth.svelte';
	import { fetchUsage, startCheckout, openBillingPortal, type Usage } from '$lib/api';
	import { formatBytes, errMsg } from '$lib/format';

	let usage = $state<Usage | null>(null);
	let error = $state('');
	let busy = $state(false);

	requireAuth(); // not signed in → /

	onMount(load);

	async function load() {
		if (!authState.clerk) return;
		try {
			usage = await fetchUsage(authState.clerk);
			error = '';
		} catch (e) {
			const m = errMsg(e);
			error = m === 'WEB_AUTH_NOT_ENABLED' ? 'Web auth isn’t enabled on the API yet.' : m;
		}
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
