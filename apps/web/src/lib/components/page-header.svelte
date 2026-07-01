<script lang="ts">
	// The title/subtitle scaffold every dashboard page opens with. Titles differ per
	// page, so the page renders this rather than the layout owning it.
	let { title, description }: { title: string; description?: string } = $props();
</script>

<header class="mb-8">
	<h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
	{#if description}
		<p class="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>
	{/if}
</header>
