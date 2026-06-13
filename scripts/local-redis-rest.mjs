#!/usr/bin/env node
/**
 * Standalone in-memory Upstash-compatible Redis REST server for self-hosting
 * WITHOUT Docker or any external Redis. Zero npm dependencies (pure Node).
 *
 * Why this exists: AlsaGlobal's RPC handlers read pre-computed data from a
 * Redis cache that the seed scripts populate. The production architecture
 * uses Upstash; the Docker stack uses a real Redis + REST proxy. This shim
 * gives the same REST surface backed by an in-process Map, so on a plain
 * `npm run dev` box you can:
 *
 *   1. node scripts/local-redis-rest.mjs        (this server, port 8079)
 *   2. bash scripts/run-seeders.sh               (populates the cache)
 *   3. npm run dev                               (handlers read the cache)
 *
 * State persists to data/local-redis.json (debounced) so a restart of this
 * process keeps the seeded data. Honors EX/PX/NX/XX on SET, lazy + swept
 * TTL expiry, and the Upstash REST shapes the app's redis.ts speaks:
 *   GET  /get/{key}                       → {"result": <string|null>}
 *   GET  /{cmd}/{arg}/...                  → {"result": ...}
 *   POST /            body ["CMD",...]     → {"result": ...}
 *   POST /pipeline    body [["CMD",...]]   → [{"result":...}, ...]
 *   POST /multi-exec  body [["CMD",...]]   → [{"result":...}, ...]
 *
 * Auth: Bearer SRH_TOKEN / REDIS_TOKEN (optional; matches docker-compose).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'local-redis.json');

const PORT = parseInt(process.env.PORT || process.env.LOCAL_REDIS_PORT || '8079', 10);
const TOKEN = process.env.SRH_TOKEN || process.env.REDIS_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

// key -> { t: 'string'|'set'|'zset'|'hash'|'list', v: any, e: number|0 }
/** @type {Map<string, {t:string, v:any, e:number}>} */
const store = new Map();

// ─── Persistence ────────────────────────────────────────────────────────────
function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const now = Date.now();
    for (const [k, e] of Object.entries(raw)) {
      if (e && (!e.e || e.e > now)) store.set(k, e);
    }
    console.log(`[local-redis] loaded ${store.size} keys from ${DATA_FILE}`);
  } catch (err) {
    console.warn('[local-redis] load failed:', err.message);
  }
}

// Persistence is debounced at 15s and writes to a temp file + rename so a
// read burst is never blocked by a partial write. The whole store is ~20MB,
// so JSON.stringify is ~100ms — at one write per 15s that's negligible, but
// at the seeder's write rate a 1.5s debounce caused save-thrash that blocked
// the single-threaded event loop and timed out concurrent reads.
let saveTimer = null;
let saveDirty = false;
function scheduleSave() {
  saveDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!saveDirty) return;
    saveDirty = false;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const obj = {};
      for (const [k, e] of store) obj[k] = e;
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, DATA_FILE);
    } catch (err) {
      console.warn('[local-redis] save failed:', err.message);
    }
  }, 15_000);
  if (typeof saveTimer === 'object' && 'unref' in saveTimer) saveTimer.unref();
}
// Flush on graceful shutdown so a Ctrl-C doesn't lose the last 15s of writes.
function flushSync() {
  if (!saveDirty) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = {};
    for (const [k, e] of store) obj[k] = e;
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj));
  } catch { /* best effort */ }
}
process.on('SIGINT', () => { flushSync(); process.exit(0); });
process.on('SIGTERM', () => { flushSync(); process.exit(0); });

// ─── TTL ──────────────────────────────────────────────────────────────────
function alive(key) {
  const e = store.get(key);
  if (!e) return null;
  if (e.e && e.e <= Date.now()) { store.delete(key); return null; }
  return e;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of store) if (e.e && e.e <= now) store.delete(k);
}, 30_000).unref?.();

// ─── Command engine ─────────────────────────────────────────────────────────
function run(args) {
  if (!Array.isArray(args) || args.length === 0) return { error: 'empty command' };
  const cmd = String(args[0]).toUpperCase();
  const A = args.slice(1).map((x) => (x == null ? '' : String(x)));

  switch (cmd) {
    case 'PING':   return { result: 'PONG' };
    case 'ECHO':   return { result: A[0] ?? '' };
    case 'DBSIZE': return { result: store.size };
    case 'INFO':   return { result: 'redis_version:local-shim\r\n' };

    case 'GET': {
      const e = alive(A[0]);
      return { result: e && e.t === 'string' ? e.v : null };
    }
    case 'SET': {
      const [key, value, ...opts] = A;
      let ex = 0, nx = false, xx = false;
      for (let i = 0; i < opts.length; i++) {
        const o = opts[i].toUpperCase();
        if (o === 'EX') ex = Date.now() + parseInt(opts[++i], 10) * 1000;
        else if (o === 'PX') ex = Date.now() + parseInt(opts[++i], 10);
        else if (o === 'NX') nx = true;
        else if (o === 'XX') xx = true;
      }
      const exists = alive(key) != null;
      if (nx && exists) return { result: null };
      if (xx && !exists) return { result: null };
      store.set(key, { t: 'string', v: value, e: ex });
      scheduleSave();
      return { result: 'OK' };
    }
    case 'SETEX': {
      store.set(A[0], { t: 'string', v: A[2], e: Date.now() + parseInt(A[1], 10) * 1000 });
      scheduleSave();
      return { result: 'OK' };
    }
    case 'SETNX': {
      if (alive(A[0])) return { result: 0 };
      store.set(A[0], { t: 'string', v: A[1], e: 0 });
      scheduleSave();
      return { result: 1 };
    }
    case 'MSET': {
      for (let i = 0; i < A.length; i += 2) store.set(A[i], { t: 'string', v: A[i + 1], e: 0 });
      scheduleSave();
      return { result: 'OK' };
    }
    case 'MGET':
      return { result: A.map((k) => { const e = alive(k); return e && e.t === 'string' ? e.v : null; }) };

    case 'DEL': {
      let n = 0;
      for (const k of A) if (store.delete(k)) n++;
      scheduleSave();
      return { result: n };
    }
    case 'EXISTS': {
      let n = 0;
      for (const k of A) if (alive(k)) n++;
      return { result: n };
    }
    case 'TYPE': {
      const e = alive(A[0]);
      return { result: e ? e.t : 'none' };
    }
    case 'EXPIRE': {
      const e = alive(A[0]);
      if (!e) return { result: 0 };
      e.e = Date.now() + parseInt(A[1], 10) * 1000;
      scheduleSave();
      return { result: 1 };
    }
    case 'PEXPIRE': {
      const e = alive(A[0]);
      if (!e) return { result: 0 };
      e.e = Date.now() + parseInt(A[1], 10);
      scheduleSave();
      return { result: 1 };
    }
    case 'TTL': {
      const e = alive(A[0]);
      if (!e) return { result: -2 };
      if (!e.e) return { result: -1 };
      return { result: Math.max(0, Math.round((e.e - Date.now()) / 1000)) };
    }
    case 'INCR': case 'DECR': case 'INCRBY': case 'DECRBY': {
      const e = alive(A[0]) || { t: 'string', v: '0', e: 0 };
      const by = cmd === 'INCR' ? 1 : cmd === 'DECR' ? -1
        : cmd === 'INCRBY' ? parseInt(A[1], 10) : -parseInt(A[1], 10);
      const next = (parseInt(e.v, 10) || 0) + by;
      store.set(A[0], { t: 'string', v: String(next), e: e.e || 0 });
      scheduleSave();
      return { result: next };
    }

    case 'SADD': {
      const e = alive(A[0]) || { t: 'set', v: [], e: 0 };
      const set = new Set(e.v);
      let added = 0;
      for (const m of A.slice(1)) if (!set.has(m)) { set.add(m); added++; }
      store.set(A[0], { t: 'set', v: [...set], e: e.e || 0 });
      scheduleSave();
      return { result: added };
    }
    case 'SREM': {
      const e = alive(A[0]); if (!e) return { result: 0 };
      const set = new Set(e.v); let n = 0;
      for (const m of A.slice(1)) if (set.delete(m)) n++;
      e.v = [...set]; scheduleSave();
      return { result: n };
    }
    case 'SMEMBERS': { const e = alive(A[0]); return { result: e ? e.v : [] }; }
    case 'SISMEMBER': { const e = alive(A[0]); return { result: e && e.v.includes(A[1]) ? 1 : 0 }; }
    case 'SCARD': { const e = alive(A[0]); return { result: e ? e.v.length : 0 }; }

    case 'HSET': case 'HMSET': {
      const e = alive(A[0]) || { t: 'hash', v: {}, e: 0 };
      let n = 0;
      for (let i = 1; i < A.length; i += 2) { if (!(A[i] in e.v)) n++; e.v[A[i]] = A[i + 1]; }
      store.set(A[0], { t: 'hash', v: e.v, e: e.e || 0 });
      scheduleSave();
      return { result: cmd === 'HMSET' ? 'OK' : n };
    }
    case 'HGET': { const e = alive(A[0]); return { result: e && A[1] in e.v ? e.v[A[1]] : null }; }
    case 'HGETALL': {
      const e = alive(A[0]); if (!e) return { result: {} };
      return { result: e.v };
    }
    case 'HMGET': { const e = alive(A[0]); return { result: A.slice(1).map((f) => (e && f in e.v ? e.v[f] : null)) }; }
    case 'HKEYS': { const e = alive(A[0]); return { result: e ? Object.keys(e.v) : [] }; }
    case 'HVALS': { const e = alive(A[0]); return { result: e ? Object.values(e.v) : [] }; }
    case 'HLEN': { const e = alive(A[0]); return { result: e ? Object.keys(e.v).length : 0 }; }
    case 'HEXISTS': { const e = alive(A[0]); return { result: e && A[1] in e.v ? 1 : 0 }; }
    case 'HDEL': {
      const e = alive(A[0]); if (!e) return { result: 0 };
      let n = 0; for (const f of A.slice(1)) if (f in e.v) { delete e.v[f]; n++; }
      scheduleSave(); return { result: n };
    }

    case 'ZADD': {
      const e = alive(A[0]) || { t: 'zset', v: [], e: 0 };
      const arr = e.v;
      for (let i = 1; i < A.length; i += 2) {
        const score = parseFloat(A[i]); const member = A[i + 1];
        const ex = arr.find((m) => m.member === member);
        if (ex) ex.score = score; else arr.push({ member, score });
      }
      store.set(A[0], { t: 'zset', v: arr, e: e.e || 0 });
      scheduleSave();
      return { result: arr.length };
    }
    case 'ZRANGE': case 'ZREVRANGE': {
      const e = alive(A[0]); if (!e) return { result: [] };
      const sorted = [...e.v].sort((a, b) => a.score - b.score);
      if (cmd === 'ZREVRANGE') sorted.reverse();
      const start = parseInt(A[1], 10), stop = parseInt(A[2], 10);
      const end = stop < 0 ? sorted.length + stop + 1 : stop + 1;
      return { result: sorted.slice(start, end).map((m) => m.member) };
    }
    case 'ZCARD': { const e = alive(A[0]); return { result: e ? e.v.length : 0 }; }
    case 'ZSCORE': { const e = alive(A[0]); const m = e?.v.find((x) => x.member === A[1]); return { result: m ? String(m.score) : null }; }

    case 'LPUSH': case 'RPUSH': {
      const e = alive(A[0]) || { t: 'list', v: [], e: 0 };
      const items = A.slice(1);
      if (cmd === 'LPUSH') e.v.unshift(...items.reverse()); else e.v.push(...items);
      store.set(A[0], { t: 'list', v: e.v, e: e.e || 0 });
      scheduleSave();
      return { result: e.v.length };
    }
    case 'LRANGE': {
      const e = alive(A[0]); if (!e) return { result: [] };
      const start = parseInt(A[1], 10), stop = parseInt(A[2], 10);
      const end = stop < 0 ? e.v.length + stop + 1 : stop + 1;
      return { result: e.v.slice(start, end) };
    }
    case 'LLEN': { const e = alive(A[0]); return { result: e ? e.v.length : 0 }; }

    case 'SCAN': {
      // SCAN cursor [MATCH pattern] [COUNT n] — we return everything in one page.
      let match = '*';
      for (let i = 1; i < A.length; i++) if (A[i].toUpperCase() === 'MATCH') match = A[i + 1];
      const re = new RegExp('^' + match.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      const keys = [];
      for (const k of store.keys()) if (alive(k) && re.test(k)) keys.push(k);
      return { result: ['0', keys] };
    }

    case 'EVAL':
      // Lua scripts aren't supported by the in-memory shim; seeders only use
      // EVAL for advisory atomic ops that degrade safely to a no-op success.
      return { result: null };

    default:
      // Unknown command — return null result rather than erroring so a seeder
      // that probes an exotic command keeps going.
      return { result: null };
  }
}

// ─── HTTP surface ───────────────────────────────────────────────────────────
function authed(req) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${TOKEN}`;
}

function send(res, code, body) {
  const json = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(json);
}

const server = http.createServer((req, res) => {
  if (!authed(req)) return send(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET') {
    // /get/{key}  or  /{cmd}/{arg}/...
    const parts = req.url.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length === 0) return send(res, 200, { result: 'PONG' });
    const cmd = parts[0].toUpperCase();
    return send(res, 200, run([cmd, ...parts.slice(1)]));
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '[]'); } catch { return send(res, 400, { error: 'bad json' }); }
      const url = req.url.split('?')[0];
      if (url === '/pipeline' || url === '/multi-exec') {
        if (!Array.isArray(parsed)) return send(res, 400, { error: 'expected array of commands' });
        return send(res, 200, parsed.map((c) => run(c)));
      }
      // POST / with a single command array
      return send(res, 200, run(parsed));
    });
    return;
  }

  send(res, 405, { error: 'method not allowed' });
});

load();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[local-redis] Upstash-compatible REST shim on http://127.0.0.1:${PORT} (auth: ${TOKEN ? 'on' : 'off'})`);
});
