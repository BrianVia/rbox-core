/** Best-effort human-readable message from a thrown value. */
export function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Compact relative time ("just now", "3h ago", "5d ago"), or "never" for null. */
export function relativeTime(ms: number | null, now: number = Date.now()): string {
	if (ms == null) return 'never';
	const diff = Math.max(0, now - ms);
	const min = Math.floor(diff / 60000);
	if (min < 1) return 'just now';
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 30) return `${day}d ago`;
	const mo = Math.floor(day / 30);
	if (mo < 12) return `${mo}mo ago`;
	return `${Math.floor(mo / 12)}y ago`;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Human-readable byte size (e.g. 250.0 GB). */
export function formatBytes(n: number): string {
	if (n == null || Number.isNaN(n)) return '—';
	if (n === 0) return '0 B';
	const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
	return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${UNITS[i]}`;
}
