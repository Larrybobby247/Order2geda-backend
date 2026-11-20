export let redis = null;
if (process.env.REDIS_URL) { const { default: Redis } = await import('ioredis'); redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 }); redis.on('error', () => {}); }
// Non-authoritative cache for public, non-sensitive reads only. Falls back to the DB if Redis is down/absent.
export async function cached(key, ttl, fn) {
  if (!redis) return fn();
  try { const hit = await redis.get(key); if (hit) return JSON.parse(hit); } catch {}
  const v = await fn(); redis.set(key, JSON.stringify(v), 'EX', ttl).catch(() => {}); return v;
}
