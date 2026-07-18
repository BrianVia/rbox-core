<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import type { Clerk } from '@clerk/clerk-js';
	import { authState, requireAuth } from '$lib/auth.svelte';
	import { fetchUsage, fetchAccountStatus, startCheckout, openBillingPortal, type Usage } from '$lib/api';
	import { consumePlanIntent } from '$lib/plan-intent';
	import { formatBytes, errMsg, friendlyErr } from '$lib/format';
	import { Card, CardContent } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { Separator } from '$lib/components/ui/separator';
	import PageHeader from '$lib/components/page-header.svelte';
	import Callout from '$lib/components/callout.svelte';
	import Loading from '$lib/components/loading.svelte';
	import CommandRow from '$lib/components/command-row.svelte';
	import Step from '$lib/components/step.svelte';
	import ApiKeysSection from '$lib/components/api-keys-section.svelte';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import Link2Icon from '@lucide/svelte/icons/link-2';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

	let usage = $state<Usage | null>(null);
	// Whether this web login already manages a CLI account (design 21). Drives the
	// "Used the rbox CLI?" link nudge below — it only makes sense for logins that
	// AREN'T linked yet. `null` = unknown (not loaded / lookup failed) → nudge hidden.
	let linked = $state<boolean | null>(null);
	let error = $state('');
	let busy = $state(false);
	let cadence = $state<'monthly' | 'annual'>('annual');

	requireAuth(); // not signed in → /

	// load() can resolve after the user has navigated away — a checkout redirect must
	// never fire from a destroyed page (plain flag, not $state: nothing renders it).
	let destroyed = false;
	onDestroy(() => (destroyed = true));

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
			error = friendlyErr(u.reason);
		}
		linked = s.status === 'fulfilled' ? s.value.linked : null;

		// Pricing-CTA handoff: a buyer who clicked "Go Pro" on the marketing site arrives
		// here post-sign-in with a stashed plan intent. Consume it one-shot FIRST (a
		// cancelled checkout returns via /billing → here and must NOT re-fire), then
		// auto-start checkout only if they still have no active plan — paid users manage
		// plans via the portal, never a second checkout. Errors surface via redirectVia.
		// If the page was destroyed mid-fetch, don't consume — the intent stays stashed
		// (within its TTL) for the buyer's next dashboard visit.
		if (destroyed) return;
		const intent = consumePlanIntent();
		if (intent && (usage?.plan ?? 'none') === 'none') checkout(intent.plan, intent.cadence);
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

	const checkout = (plan: 'solo' | 'pro', selectedCadence: 'monthly' | 'annual' = cadence) =>
		redirectVia((c) => startCheckout(c, plan, selectedCadence));
	const portal = () => redirectVia(openBillingPortal);

	// Display metadata per plan (matches apps/api/src/plans.ts).
	type Tier = 'none' | 'solo' | 'pro' | 'team';
	const PLAN: Record<Tier, { label: string; price: string }> = {
		none: { label: 'No plan', price: '—' },
		solo: { label: 'Solo', price: '$8/mo' },
		pro: { label: 'Pro', price: '$20/mo' },
		team: { label: 'Team', price: '$12/seat' }
	};

	const UPGRADES: {
		id: 'solo' | 'pro';
		label: string;
		monthlyPrice: string;
		annualPrice: string;
		annualTotal: string;
		features: string[];
		featured?: boolean;
	}[] = [
		{
			id: 'solo',
			label: 'Solo',
			monthlyPrice: '$8',
			annualPrice: '$6.67',
			annualTotal: '$80',
			features: ['50 GB storage', '30-day version history', 'Unlimited workspaces']
		},
		{
			id: 'pro',
			label: 'Pro',
			monthlyPrice: '$20',
			annualPrice: '$16.67',
			annualTotal: '$200',
			features: ['250 GB storage', '365-day version history', 'Advanced hydration'],
			featured: true
		}
	];

	// Getting-started commands — the exact, copy-pasteable onboarding a brand-new
	// login needs. Kept as consts so the copy button hands over byte-for-byte
	// what's shown.
	const INSTALL_CMD = 'curl -fsSL https://rbox.to/install.sh | sh';
	const SETUP_CMD = 'rbox setup';
	const DOCS_URL = 'https://rbox.to/docs';

	const plan = $derived((usage?.plan as Tier) ?? 'none');
	const noPlan = $derived(plan === 'none');
	const info = $derived(PLAN[plan] ?? PLAN.none);
	// The active-subscription summary must show the price the account is actually
	// paying, not always the monthly one (validation note #21). usage.interval is
	// only meaningful once a plan is active; 'monthly' and null (unknown — e.g.
	// pre-migration rows) both fall back to the existing monthly label. Reuses the
	// same per-plan annual price metadata as the checkout cards below — no new
	// hardcoded numbers.
	const activePrice = $derived.by(() => {
		if (noPlan) return info.price;
		const tier = UPGRADES.find((p) => p.id === plan);
		if (usage?.interval === 'annual' && tier) return `${tier.annualTotal}/year`;
		return info.price;
	});
	const pct = $derived(
		usage && usage.storageCap ? Math.min(100, (usage.usedBytes / usage.storageCap) * 100) : 0
	);
</script>

<PageHeader title="Overview" description="Your plan, usage, and account at a glance." />

{#if error}
	<Callout class="mb-6">{error}</Callout>
{/if}

{#if usage}
	<!-- Account summary: plan + usage in one cohesive panel (no card-in-card noise). -->
	<Card>
		<CardContent class="p-6">
			<div class="flex flex-wrap items-center justify-between gap-4">
				<div class="flex items-center gap-3">
					<Badge variant={noPlan ? 'secondary' : 'default'} class="px-2.5 py-0.5 text-sm">
						{info.label}
					</Badge>
					<span class="text-sm text-muted-foreground">
						{noPlan ? 'No active plan' : 'Active subscription'}
					</span>
				</div>
				<div class="flex items-center gap-4">
					<span class="text-lg font-semibold tabular">{activePrice}</span>
					{#if !noPlan}
						<Button variant="outline" size="sm" disabled={busy} onclick={portal}>
							Manage billing
						</Button>
					{/if}
				</div>
			</div>

			<!-- Usage metrics only make sense once there's a plan; a brand-new account has
			     nothing but zeroes to show, so we hide the whole block until noPlan clears. -->
			{#if !noPlan}
				<Separator class="my-5" />

				<div>
					<div class="flex items-baseline justify-between text-sm">
						<span class="text-muted-foreground">Storage</span>
						<span>
							<span class="font-medium tabular">{formatBytes(usage.usedBytes)}</span>
							<span class="text-muted-foreground">
								of {usage.storageCap === null ? '∞' : formatBytes(usage.storageCap)}
							</span>
						</span>
					</div>
					{#if usage.storageCap !== null}
						<Progress value={pct} class="mt-2.5 h-2" />
					{/if}
				</div>

				<Separator class="my-5" />

				<div class="grid grid-cols-2 gap-4">
					<div>
						<div class="text-xl font-semibold tabular">
							{usage.workspaces}{usage.workspaceCap === null ? '' : `/${usage.workspaceCap}`}
						</div>
						<div class="mt-0.5 text-xs text-muted-foreground">Workspaces</div>
					</div>
					<div>
						<div class="text-xl font-semibold tabular">{usage.retentionDays}d</div>
						<div class="mt-0.5 text-xs text-muted-foreground">Version history</div>
					</div>
				</div>
			{/if}
		</CardContent>
	</Card>

	{#if noPlan}
		<!-- Locked → trial. This is the primary next step for a brand-new account, so it
		     sits immediately below the plan line. Cards make the choice + value obvious.
		     Paid users change plans via the portal (in the summary above), never a second
		     checkout — this block only renders while there's no active plan. -->
		<div class="mt-6 mb-4 flex flex-wrap items-center justify-between gap-3">
			<h2 class="text-lg font-semibold tracking-tight">Start your 14-day free trial</h2>
			<div class="inline-flex rounded-lg border border-border bg-muted/50 p-1">
				<button
					type="button"
					class="rounded-md px-3 py-1.5 text-sm transition-colors {cadence === 'annual'
						? 'bg-background text-foreground shadow-sm'
						: 'text-muted-foreground hover:text-foreground'}"
					onclick={() => (cadence = 'annual')}
					aria-pressed={cadence === 'annual'}
				>
					Annual
				</button>
				<button
					type="button"
					class="rounded-md px-3 py-1.5 text-sm transition-colors {cadence === 'monthly'
						? 'bg-background text-foreground shadow-sm'
						: 'text-muted-foreground hover:text-foreground'}"
					onclick={() => (cadence = 'monthly')}
					aria-pressed={cadence === 'monthly'}
				>
					Monthly
				</button>
			</div>
		</div>
		<div class="grid gap-4 sm:grid-cols-2">
			{#each UPGRADES as p (p.id)}
				<div
					class="relative flex flex-col rounded-xl border bg-card p-5 {p.featured
						? 'border-primary/50 ring-1 ring-primary/20'
						: 'border-border'}"
				>
					{#if p.featured}
						<span class="absolute -top-2.5 left-5 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold tracking-wide text-primary-foreground uppercase">
							Most popular
						</span>
					{/if}
					<div class="text-sm font-medium text-muted-foreground">{p.label}</div>
					<div class="mt-1 mb-4 flex items-baseline gap-1">
						<span class="text-3xl font-semibold tracking-tight tabular">{cadence === 'annual' ? p.annualPrice : p.monthlyPrice}</span>
						<span class="text-sm text-muted-foreground">
							{cadence === 'annual' ? '/mo · billed annually' : '/mo'}
						</span>
					</div>
					<ul class="mb-5 flex flex-1 flex-col gap-2.5">
						{#each p.features as f (f)}
							<li class="flex items-start gap-2 text-sm text-muted-foreground">
								<CheckIcon class="mt-0.5 size-4 shrink-0 text-success" />
								{f}
							</li>
						{/each}
					</ul>
					<Button
						variant={p.featured ? 'default' : 'outline'}
						disabled={busy}
						onclick={() => checkout(p.id)}
					>
						Start {p.label} trial
					</Button>
				</div>
			{/each}
		</div>
		<p class="mt-4 text-center text-xs text-muted-foreground">
			Need a team? <strong class="font-medium text-foreground">Team plans</strong> with roles &amp; per-seat billing are coming soon.
		</p>
	{/if}

	<!-- Discovery nudge (design 21 §6 / 17 §4.1): route CLI-first users to the
	     possession-proof link flow. Shown ONLY to logins that aren't linked yet. -->
	{#if linked === false}
		<a
			href="/link"
			class="group mt-4 flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3.5 transition-colors hover:border-primary/40 hover:bg-accent/40"
		>
			<span class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
				<Link2Icon class="size-4" />
			</span>
			<span class="min-w-0">
				<span class="block text-sm font-medium">
					Already using the <code class="rounded bg-muted px-1 py-0.5 text-[0.8em]">rbox</code> CLI? Link your account
					<ArrowRightIcon class="inline size-3.5 -translate-y-px transition-transform group-hover:translate-x-0.5" />
				</span>
				<span class="mt-0.5 block text-xs text-muted-foreground">
					Connect your machines to manage their devices, workspaces &amp; billing here.
				</span>
			</span>
		</a>
	{/if}

	<!-- Getting started (design 21/29): CLI-first onboarding for a brand-new login.
	     Collapsible; open by default until a CLI account is linked. -->
	<details class="group mt-4 overflow-hidden rounded-lg border border-border bg-card" open={linked === false}>
		<summary
			class="flex cursor-pointer list-none items-center justify-between px-4 py-3.5 text-sm [&::-webkit-details-marker]:hidden"
		>
			<span><strong class="font-semibold text-foreground">New to rbox?</strong> Set up the CLI in three steps</span>
			<ChevronDownIcon class="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
		</summary>
		<div class="border-t border-border px-4 py-4">
			<ol class="flex flex-col gap-5">
				<Step n={1}>
					<div class="text-sm font-medium">Install rbox</div>
					<p class="mt-0.5 text-xs text-muted-foreground">One line — adds the <code class="rounded bg-muted px-1 py-0.5">rbox</code> command on macOS or Linux.</p>
					<CommandRow command={INSTALL_CMD} />
				</Step>
				<Step n={2}>
					<div class="text-sm font-medium">Run <code class="rounded bg-muted px-1 py-0.5">rbox setup</code></div>
					<p class="mt-0.5 text-xs text-muted-foreground">
						Creates your account, saves your recovery phrase, tracks a folder, and starts syncing in the background.
					</p>
					<CommandRow command={SETUP_CMD} />
					<p class="mt-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
						Save your recovery phrase somewhere safe — it's the only way back into your account. No one can reset it for you.
					</p>
				</Step>
				<Step n={3}>
					<div class="text-sm font-medium">Link this dashboard</div>
					<p class="mt-0.5 text-xs text-muted-foreground">Connect your machines so you can manage devices, workspaces &amp; billing here.</p>
					<div class="mt-2 rounded-md border border-border bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground">rbox account link &lt;code&gt;</div>
					<Button variant="outline" size="sm" class="mt-2" onclick={() => goto('/link')}>
						Get your code
						<ArrowRightIcon class="size-3.5" />
						</Button>
				</Step>
			</ol>
			<a
				href={DOCS_URL}
				class="mt-5 inline-flex text-xs font-medium text-primary underline-offset-4 hover:underline"
			>
				Read the rbox docs
			</a>
		</div>
	</details>

	{#if linked === true}
		<ApiKeysSection class="mt-8" />
	{/if}
{:else if !error}
	<Loading label="Loading account…" />
{/if}
