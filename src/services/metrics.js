import { monitorEventLoopDelay } from 'perf_hooks';
const h = monitorEventLoopDelay({ resolution: 20 }); h.enable(); const lat = []; let count = 0, errors = 0;
export const metricsMiddleware = (req, res, next) => { const t = process.hrtime.bigint(); res.on('finish', () => { count++; if (res.statusCode >= 500) errors++; lat.push(Number(process.hrtime.bigint() - t) / 1e6); if (lat.length > 2000) lat.shift(); }); next(); };
export function snapshot() { const s = [...lat].sort((a, b) => a - b); const q = (p) => (s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1) : 0);
  return { requests: count, errors5xx: errors, latencyMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99) }, eventLoopLagMs: { mean: +(h.mean / 1e6).toFixed(2), max: +(h.max / 1e6).toFixed(2) }, memoryMB: Math.round(process.memoryUsage().rss / 1048576), uptimeSec: Math.round(process.uptime()) }; }
