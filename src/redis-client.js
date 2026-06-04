const url   = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

let client;

if (url && token) {
  const { Redis } = require('@upstash/redis');
  client = new Redis({ url, token });
} else {
  console.warn('[redis] WARNING: Redis not configured - using in-memory fallback (data will not persist across restarts)');

  const store = new Map();
  client = {
    get:  async (k)       => { const v = store.get(k); return v !== undefined ? v : null; },
    set:  async (k, v)    => { store.set(k, v); return 'OK'; },
    del:  async (k)       => { const had = store.has(k); store.delete(k); return had ? 1 : 0; },
    keys: async (pattern) => {
      const prefix = pattern.replace(/\*$/, '');
      return [...store.keys()].filter(k => k.startsWith(prefix));
    },
    mget: async (...keys) => keys.flat().map(k => { const v = store.get(k); return v !== undefined ? v : null; }),
  };
}

module.exports = client;
