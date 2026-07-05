// Durable key/value + set storage for persistent features (colonies).
// Uses Upstash Redis when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are
// set (production, on Render), else an in-memory fallback so the server runs and
// is testable locally without any external service. The in-memory backend
// serializes values so it mimics Redis copy semantics (no accidental aliasing).
let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('[store] Upstash Redis connected (durable)');
  } catch (e) {
    console.log('[store] Upstash init failed, using in-memory store:', e.message);
  }
}

const mem = new Map(); // key -> JSON string
const memSets = new Map(); // key -> Set

module.exports = {
  durable: !!redis,

  async get(key) {
    if (redis) return (await redis.get(key)) ?? null;
    const v = mem.get(key);
    return v == null ? null : JSON.parse(v);
  },
  async set(key, val) {
    if (redis) return redis.set(key, val);
    mem.set(key, JSON.stringify(val));
  },
  async del(key) {
    if (redis) return redis.del(key);
    mem.delete(key);
  },
  async sadd(key, member) {
    if (redis) return redis.sadd(key, member);
    if (!memSets.has(key)) memSets.set(key, new Set());
    memSets.get(key).add(member);
  },
  async srem(key, member) {
    if (redis) return redis.srem(key, member);
    memSets.get(key)?.delete(member);
  },
  async smembers(key) {
    if (redis) return (await redis.smembers(key)) ?? [];
    return memSets.has(key) ? [...memSets.get(key)] : [];
  },
};
