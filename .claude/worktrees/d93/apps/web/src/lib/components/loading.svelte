<script lang="ts">
	// The single inline "working…" indicator (pulse dot + label).
	let { label = 'Loading…' }: { label?: string } = $props();
</script>

<div class="flex items-center gap-2 text-sm text-muted-foreground">
	<span class="size-2 animate-pulse rounded-full bg-primary"></span>
	{label}
</div>
