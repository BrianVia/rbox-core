<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	// A destructive inline alert (the one error surface across every page). Pass
	// spacing via `class` (e.g. mb-6) — the variant styling lives here so it's tuned
	// in one place.
	let { class: className, children }: { class?: string; children: Snippet } = $props();
</script>

<div
	role="alert"
	class={cn(
		'rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive',
		className
	)}
>
	{@render children()}
</div>
