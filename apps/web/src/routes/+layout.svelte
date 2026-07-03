<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { getClerk } from '$lib/clerk';
	import { clearStaleTokens } from '$lib/api';
	import { authState, setClerk, syncSignedIn } from '$lib/auth.svelte';
	import { errMsg } from '$lib/format';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import Loading from '$lib/components/loading.svelte';
	import { cn } from '$lib/utils';
	import '@fontsource-variable/hanken-grotesk/index.css';
	import '../app.css';

	let { children } = $props();
	let ready = $state(false);
	let fatal = $state('');
	let mobileNavEl: HTMLElement | null = $state(null);

	onMount(async () => {
		try {
			const clerk = await getClerk();
			setClerk(clerk);
			clearStaleTokens(clerk.session?.id ?? null);
			// On any Clerk session/user change: drop tokens that aren't the live
			// session (B3) and re-sync signed-in state for the router.
			clerk.addListener(() => {
				clearStaleTokens(clerk.session?.id ?? null);
				syncSignedIn();
			});
			ready = true;
		} catch (e) {
			fatal = errMsg(e);
		}
	});

	// The signed-out landing ("/") is a focused auth card, not the app. Every other
	// route lives inside the persistent dashboard shell (sidebar + content).
	const isAuth = $derived(page.url.pathname === '/');

	// Every non-"/" route is authenticated. The LAYOUT owns the signed-out redirect:
	// the branch below renders a loader (not the page) for a signed-out deep-link, so
	// the page never mounts and its own requireAuth() would never run. Redirect here
	// instead. (Add a public-route set / route group before shipping a second public
	// route — this assumes "/" is the only public one.)
	$effect(() => {
		if (ready && !isAuth && !authState.signedIn) goto('/');
	});

	const nav = [
		{ href: '/dashboard', label: 'Overview', shortLabel: 'Overview', icon: LayoutDashboardIcon },
		{
			href: '/devices',
			label: 'Devices & workspaces',
			shortLabel: 'Devices',
			icon: HardDriveIcon
		},
		{ href: '/settings', label: 'Settings', shortLabel: 'Settings', icon: SettingsIcon }
	];
	// Active = exact path match. Nested/transient routes (billing/success, link)
	// aren't in the nav, so they simply light nothing — no prefix logic needed.
	const isActive = (href: string) => page.url.pathname === href;

	const email = $derived(authState.clerk?.user?.primaryEmailAddress?.emailAddress ?? '');

	function scrollActiveMobileNavIntoView() {
		if (!mobileNavEl || mobileNavEl.scrollWidth <= mobileNavEl.clientWidth) return;
		const activeLink = mobileNavEl.querySelector<HTMLAnchorElement>('a[aria-current="page"]');
		activeLink?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
	}

	$effect(() => {
		const pathname = page.url.pathname;
		if (!ready || isAuth || !authState.signedIn) return;

		tick().then(() => {
			if (page.url.pathname !== pathname) return;
			scrollActiveMobileNavIntoView();
		});
	});

	async function signOut() {
		try {
			await authState.clerk?.signOut();
		} finally {
			goto('/');
		}
	}
</script>

<svelte:head>
	<title>rbox — account</title>
</svelte:head>

{#snippet wordmark(size: 'sm' | 'lg')}
	<div class="flex items-baseline gap-2 select-none">
		<span class={cn('font-bold tracking-tight text-foreground', size === 'lg' ? 'text-2xl' : 'text-lg')}>
			rbox
		</span>
		<span class="text-sm text-muted-foreground">account</span>
	</div>
{/snippet}

{#snippet navLinks(variant: 'sidebar' | 'mobile')}
	{#each nav as item (item.href)}
		{@const Icon = item.icon}
		{@const active = isActive(item.href)}
		<a
			href={item.href}
			aria-current={active ? 'page' : undefined}
			class={cn(
				'flex items-center rounded-md text-sm font-medium transition-colors',
				variant === 'mobile'
					? 'min-h-11 shrink-0 gap-1.5 px-2 py-2'
					: 'gap-2.5 px-3 py-2',
				active
					? 'bg-sidebar-accent text-sidebar-accent-foreground'
					: 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
			)}
		>
			<Icon class="size-4 shrink-0 opacity-80" />
			<span class={variant === 'mobile' ? 'whitespace-nowrap' : 'truncate'}>
				{variant === 'mobile' ? item.shortLabel : item.label}
			</span>
		</a>
	{/each}
{/snippet}

{#snippet accountMenu(trigger: 'sidebar' | 'bar')}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger
			class={cn(
				'flex items-center gap-2 rounded-md text-left transition-colors outline-none',
				'focus-visible:ring-2 focus-visible:ring-ring',
				trigger === 'sidebar'
					? 'w-full p-2 hover:bg-sidebar-accent/60'
					: 'min-h-11 min-w-11 justify-center p-1.5 hover:bg-accent'
			)}
		>
			<span
				class="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary tabular"
				aria-hidden="true"
			>
				{email ? email[0]?.toUpperCase() : '·'}
			</span>
			{#if trigger === 'sidebar'}
				<span class="min-w-0 flex-1">
					<span class="block truncate text-sm font-medium text-sidebar-foreground">
						{email || 'Signed in'}
					</span>
				</span>
				<ChevronsUpDownIcon class="size-4 shrink-0 text-muted-foreground" />
			{/if}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content class="w-56" align="end">
			{#if email}
				<DropdownMenu.Label class="font-normal">
					<span class="block text-xs text-muted-foreground">Signed in as</span>
					<span class="block truncate text-sm font-medium">{email}</span>
				</DropdownMenu.Label>
				<DropdownMenu.Separator />
			{/if}
			<DropdownMenu.Item onSelect={() => goto('/settings')}>
				<SettingsIcon class="size-4" />
				Settings
			</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={signOut}>
				<LogOutIcon class="size-4" />
				Sign out
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/snippet}

{#if fatal}
	<div class="grid min-h-svh place-items-center p-6">
		<div class="max-w-sm text-center">
			{@render wordmark('lg')}
			<p class="mt-4 text-sm text-destructive">Couldn't start: {fatal}</p>
		</div>
	</div>
{:else if !ready}
	<div class="grid min-h-svh place-items-center p-6">
		<Loading />
	</div>
{:else if isAuth}
	<!-- Signed-out landing: focused, centered auth card. -->
	<div class="grid min-h-svh place-items-center p-6">
		<div class="w-full max-w-sm">
			<div class="mb-6 flex justify-center">{@render wordmark('lg')}</div>
			{@render children()}
		</div>
	</div>
{:else if !authState.signedIn}
	<!-- Signed-out but deep-linked to an app route: each page's requireAuth() is
	     about to redirect to '/'. Show a neutral loader for that frame rather than
	     flashing the authed sidebar/account chrome. -->
	<div class="grid min-h-svh place-items-center p-6">
		<Loading />
	</div>
{:else}
	<!-- App shell: persistent sidebar (desktop) / top bar (mobile) + content. -->
	<div class="min-h-svh bg-background md:grid md:grid-cols-[16rem_1fr]">
		<!-- Desktop sidebar -->
		<aside
			class="sticky top-0 hidden h-svh flex-col border-r border-sidebar-border bg-sidebar p-4 md:flex"
		>
			<div class="px-2 py-2">{@render wordmark('sm')}</div>
			<nav class="mt-4 flex flex-1 flex-col gap-1">
				{@render navLinks('sidebar')}
			</nav>
			<div class="border-t border-sidebar-border pt-3">
				{@render accountMenu('sidebar')}
			</div>
		</aside>

		<!-- Mobile top bar + horizontal nav -->
		<div class="flex flex-col md:hidden">
			<header class="flex items-center justify-between border-b border-border px-4 py-3">
				{@render wordmark('sm')}
				{@render accountMenu('bar')}
			</header>
			<nav bind:this={mobileNavEl} class="flex gap-1 overflow-x-auto border-b border-border px-3 py-2">
				{@render navLinks('mobile')}
			</nav>
		</div>

		<!-- Content -->
		<main class="min-w-0">
			<div class="mx-auto w-full max-w-3xl px-5 py-8 md:px-10 md:py-12">
				{@render children()}
			</div>
		</main>
	</div>
{/if}
