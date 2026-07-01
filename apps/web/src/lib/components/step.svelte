<script lang="ts">
	import type { Snippet } from 'svelte';

	// One numbered step in an onboarding/wizard ordered list: the number chip + its
	// content column. Used by the getting-started and link flows.
	let { n, children }: { n: number; children: Snippet } = $props();
</script>

<li class="grid grid-cols-[1.5rem_1fr] gap-x-3">
	<span class="grid size-6 place-items-center rounded-full bg-secondary text-xs font-semibold tabular">
		{n}
	</span>
	<div class="min-w-0">{@render children()}</div>
</li>
