const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Human-readable byte size (e.g. 250.0 GB). */
export function formatBytes(n: number): string {
	if (n == null || Number.isNaN(n)) return '—';
	if (n === 0) return '0 B';
	const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
	return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${UNITS[i]}`;
}
