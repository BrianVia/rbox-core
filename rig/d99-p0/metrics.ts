import fsSync from "node:fs";

export function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

export function summary(values: number[]) {
  return { p50: quantile(values, 0.5), min: Math.min(...values), max: Math.max(...values) };
}

/** Bootstrap 95% CI on the relative p50 delta (a-b)/a from per-run wall samples. */
export function bootstrapDeltaCI(aWalls: number[], bWalls: number[], iterations = 10_000): { lo: number; hi: number } {
  let x = 0x9e3779b9;
  const rand = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
  const resample = (v: number[]) => quantile(Array.from({ length: v.length }, () => v[Math.floor(rand() * v.length)]), 0.5);
  const deltas: number[] = [];
  for (let i = 0; i < iterations; i++) { const a = resample(aWalls); deltas.push((a - resample(bWalls)) / a); }
  return { lo: quantile(deltas, 0.025), hi: quantile(deltas, 0.975) };
}

export function startSamplers(intervalMs = 5) {
  const fdCount = () => { try { return fsSync.readdirSync("/proc/self/fd").length; } catch { return 0; } };
  let rss = process.memoryUsage().rss, fd = fdCount(); // initialize both immediately
  const timer = setInterval(() => {
    rss = Math.max(rss, process.memoryUsage().rss);
    fd = Math.max(fd, fdCount());
  }, intervalMs);
  return { stop() { clearInterval(timer); return { rssSamplerBytes: rss, peakFdCount: fd, maxRssBytes: process.resourceUsage().maxRSS * 1024 }; } };
}
