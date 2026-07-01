<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';

	// A copy-pasteable shell command: the code box + a copy button that owns its own
	// "Copied ✓" state. `copyText` defaults to what's shown (used where the copied
	// command differs from the displayed one is not needed, but kept flexible).
	let { command, copyText }: { command: string; copyText?: string } = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function copy() {
		try {
			await navigator.clipboard.writeText(copyText ?? command);
			copied = true;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => (copied = false), 2000);
		} catch {
			/* clipboard blocked — the command is visible to copy manually */
		}
	}
	onDestroy(() => {
		if (timer) clearTimeout(timer);
	});
</script>

<div class="mt-2 flex items-center gap-2">
	<code class="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted/50 px-3 py-2 font-mono text-xs whitespace-nowrap">
		{command}
	</code>
	<Button variant="outline" size="sm" class="shrink-0" onclick={copy}>
		{#if copied}
			<CheckIcon class="size-3.5 text-success" /> Copied
		{:else}
			<CopyIcon class="size-3.5" /> Copy
		{/if}
	</Button>
</div>
