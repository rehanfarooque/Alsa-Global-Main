#!/usr/bin/env node
/**
 * Full market-panel coverage probe.
 *
 * For every alt-coin / AI / DeFi / stablecoin / stock / forex / index symbol
 * the dashboard ships with, hit the actual upstream this panel uses and
 * report which symbols come back with real data. End result: a table that
 * tells you exactly which panels are healthy and which aren't.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SHARED = resolve(ROOT, 'shared');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT = 10_000;

const cryptoCfg     = JSON.parse(readFileSync(resolve(SHARED, 'crypto.json'), 'utf8'));
const aiCfg         = JSON.parse(readFileSync(resolve(SHARED, 'ai-tokens.json'), 'utf8'));
const defiCfg       = JSON.parse(readFileSync(resolve(SHARED, 'defi-tokens.json'), 'utf8'));
const otherCfg      = JSON.parse(readFileSync(resolve(SHARED, 'other-tokens.json'), 'utf8'));
const stablecoinCfg = JSON.parse(readFileSync(resolve(SHARED, 'stablecoins.json'), 'utf8'));
const stocksCfg     = JSON.parse(readFileSync(resolve(SHARED, 'stocks.json'), 'utf8'));
const gulfCfg       = JSON.parse(readFileSync(resolve(SHARED, 'gulf.json'), 'utf8'));
const commoditiesCfg = JSON.parse(readFileSync(resolve(SHARED, 'commodities.json'), 'utf8'));

// ─────────────────────────────────────────────────────────────────────────────
// CoinGecko probe (primary for all token categories)
// ─────────────────────────────────────────────────────────────────────────────
async function cgMarkets(ids) {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(',')}&order=market_cap_desc&sparkline=false`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, ms, reason: `HTTP ${res.status}`, returned: 0 };
    const json = await res.json();
    return { ok: Array.isArray(json), ms, returned: Array.isArray(json) ? json.length : 0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e.name === 'TimeoutError' ? 'timeout' : e.message, returned: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CoinPaprika probe (fallback for tokens)
// ─────────────────────────────────────────────────────────────────────────────
async function cpAllTickers() {
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.coinpaprika.com/v1/tickers?quotes=USD', { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(TIMEOUT) });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, ms, reason: `HTTP ${res.status}`, ids: new Set() };
    const json = await res.json();
    return { ok: true, ms, ids: new Set(json.map((t) => t.id)) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e.message, ids: new Set() };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Yahoo session + quote (now the canonical for stocks/forex/indices/etc.)
// ─────────────────────────────────────────────────────────────────────────────
let yahooSession = null;
async function ensureYahooSession() {
  if (yahooSession) return yahooSession;
  const BROWSER = { 'User-Agent': CHROME_UA, Accept: 'text/html', 'Accept-Language': 'en-US' };
  const API = { 'User-Agent': CHROME_UA, Accept: 'application/json', Origin: 'https://finance.yahoo.com', Referer: 'https://finance.yahoo.com/' };
  const r1 = await fetch('https://finance.yahoo.com/quote/AAPL', { headers: BROWSER, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
  const cookies = (r1.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  if (!cookies) return null;
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...API, Cookie: cookies }, signal: AbortSignal.timeout(TIMEOUT) });
  let crumb = '';
  if (r2.ok) {
    const body = (await r2.text()).trim();
    if (body && body.length <= 64 && !body.includes('<') && !body.startsWith('{') && /^[A-Za-z0-9._\-/+=]+$/.test(body)) crumb = body;
  }
  yahooSession = { cookies, crumb };
  return yahooSession;
}

async function yhQuote(symbol) {
  const sess = await ensureYahooSession();
  if (!sess) return { ok: false, ms: 0, reason: 'no session' };
  const sep = '?';
  const q = `interval=1d&range=5d${sess.crumb ? `&crumb=${encodeURIComponent(sess.crumb)}` : ''}`;
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}${sep}${q}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA, Accept: 'application/json', Cookie: sess.cookies, Referer: 'https://finance.yahoo.com/', Origin: 'https://finance.yahoo.com' }, signal: AbortSignal.timeout(TIMEOUT) });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, ms, reason: `HTTP ${res.status}` };
    const j = await res.json();
    const meta = j?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return { ok: false, ms, reason: 'empty' };
    return { ok: true, ms, price: meta.regularMarketPrice, ccy: meta.currency };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stooq probe (used by gulf, sector-summary, commodity)
// ─────────────────────────────────────────────────────────────────────────────
async function stooqQuote(symbol) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv' }, signal: AbortSignal.timeout(5000) });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, ms, reason: `HTTP ${res.status}` };
    const csv = await res.text();
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return { ok: false, ms, reason: 'empty CSV' };
    const cols = lines[1].split(',');
    if (cols[3] === 'N/D' || cols[6] === 'N/D') return { ok: false, ms, reason: 'N/D' };
    const close = parseFloat(cols[6]);
    if (!isFinite(close) || close === 0) return { ok: false, ms, reason: 'no price' };
    return { ok: true, ms, price: close };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Frankfurter (forex)
// ─────────────────────────────────────────────────────────────────────────────
async function frkFx(base) {
  const t0 = Date.now();
  try {
    const res = await fetch(`https://api.frankfurter.app/latest?from=${base}`, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(TIMEOUT) });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, ms, reason: `HTTP ${res.status}` };
    const j = await res.json();
    return { ok: !!j.rates, ms, count: Object.keys(j.rates || {}).length };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FRED (macro)
// ─────────────────────────────────────────────────────────────────────────────
function loadFredKey() {
  try {
    const env = readFileSync(resolve(ROOT, '.env'), 'utf8');
    return env.match(/^FRED_API_KEY=(.+)$/m)?.[1]?.trim() || '';
  } catch { return ''; }
}
async function fredSeries(id, key) {
  if (!key) return { ok: false, ms: 0, reason: 'no FRED_API_KEY' };
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&limit=1&sort_order=desc`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, ms, reason: `HTTP ${res.status}` };
    const j = await res.json();
    return { ok: Array.isArray(j.observations) && j.observations.length > 0, ms };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RUN
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(72));
console.log('  MARKET PANEL COVERAGE PROBE');
console.log('═'.repeat(72) + '\n');

const cryptoIds = Object.keys(cryptoCfg.meta || {});
const aiIds         = Object.keys(aiCfg.meta || {});
const defiIds       = Object.keys(defiCfg.meta || {});
const otherIds      = Object.keys(otherCfg.meta || {});
const stablecoinIds = Object.keys(stablecoinCfg.meta || {});

console.log('═══ CRYPTO TOKEN PANELS (CoinGecko primary, CoinPaprika fallback) ═══\n');

for (const [label, ids, cpMap] of [
  ['list-crypto-quotes',       cryptoIds,     cryptoCfg.coinpaprika || {}],
  ['list-ai-tokens',           aiIds,         aiCfg.coinpaprika || {}],
  ['list-defi-tokens',         defiIds,       defiCfg.coinpaprika || {}],
  ['list-other-tokens',        otherIds,      otherCfg.coinpaprika || {}],
  ['list-stablecoin-markets',  stablecoinIds, stablecoinCfg.coinpaprika || {}],
]) {
  process.stdout.write(`  ${label.padEnd(28)} ${String(ids.length).padStart(3)} ids …`);
  const cg = await cgMarkets(ids);
  if (cg.ok) {
    console.log(` CG ✓ ${cg.returned}/${ids.length} (${cg.ms}ms)`);
  } else {
    process.stdout.write(` CG ✗ ${cg.reason} → CoinPaprika fallback…`);
    const cp = await cpAllTickers();
    const matched = cp.ok ? Object.values(cpMap).filter((id) => cp.ids.has(id)).length : 0;
    console.log(cp.ok ? ` CP ✓ ${matched}/${ids.length} (${cp.ms}ms)` : ` CP ✗ ${cp.reason}`);
  }
  await new Promise(r => setTimeout(r, 250));
}

console.log('\n═══ CRYPTO SECTORS ═══\n');
{
  const url = 'https://api.coingecko.com/api/v3/coins/categories';
  process.stdout.write('  list-crypto-sectors            CG /categories …');
  try {
    const t0 = Date.now();
    const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(TIMEOUT) });
    const j = res.ok ? await res.json() : null;
    console.log(res.ok && Array.isArray(j) ? ` ✓ ${j.length} sectors (${Date.now()-t0}ms)` : ` ✗ HTTP ${res.status}`);
  } catch (e) { console.log(` ✗ ${e.message}`); }
}

console.log('\n═══ STOCK / INDEX PANELS (Yahoo with cookie+crumb) ═══\n');
console.log('  Priming Yahoo session…');
const sess = await ensureYahooSession();
console.log(`  → cookies: ${sess?.cookies ? 'yes' : 'no'}, crumb: ${sess?.crumb || 'cookies-only'}\n`);

const stockSubset = (stocksCfg.symbols || []).slice(0, 12);
let stockOk = 0;
for (const s of stockSubset) {
  const r = await yhQuote(s.symbol);
  if (r.ok) { stockOk++; console.log(`  ✓ ${s.symbol.padEnd(16)} ${String(r.ms).padStart(5)}ms  ${r.price.toFixed(2)} ${r.ccy}`); }
  else      { console.log(`  ✗ ${s.symbol.padEnd(16)} ${String(r.ms).padStart(5)}ms  ${r.reason}`); }
  await new Promise(r => setTimeout(r, 200));
}
console.log(`  list-market-quotes               ${stockOk}/${stockSubset.length} stocks via Yahoo\n`);

console.log('═══ COMMODITY / FUTURES PANEL (Yahoo) ═══\n');
let comOk = 0;
const commodityList = commoditiesCfg.symbols || [];
for (const c of commodityList) {
  const r = await yhQuote(c.symbol);
  if (r.ok) { comOk++; console.log(`  ✓ ${c.symbol.padEnd(12)} ${(c.name||'').padEnd(28)} ${String(r.ms).padStart(5)}ms  ${r.price.toFixed(2)}`); }
  else      { console.log(`  ✗ ${c.symbol.padEnd(12)} ${(c.name||'').padEnd(28)} ${String(r.ms).padStart(5)}ms  ${r.reason}`); }
  await new Promise(r => setTimeout(r, 200));
}
console.log(`  list-commodity-quotes            ${comOk}/${commodityList.length}\n`);

console.log('═══ GULF / MENA PANEL (Yahoo + Stooq) ═══\n');
let gulfOk = 0;
const gulfSyms = gulfCfg.symbols || [];
for (const g of gulfSyms) {
  // Try Yahoo first (now reliable), then Stooq
  let r = await yhQuote(g.symbol);
  let src = 'Yahoo';
  if (!r.ok && g.stooq) { r = await stooqQuote(g.stooq); src = 'Stooq'; }
  if (r.ok) { gulfOk++; console.log(`  ✓ ${g.symbol.padEnd(14)} (${src})  ${r.price.toFixed(2)}`); }
  else      { console.log(`  ✗ ${g.symbol.padEnd(14)} ${r.reason}`); }
  await new Promise(r => setTimeout(r, 200));
}
console.log(`  list-gulf-quotes                 ${gulfOk}/${gulfSyms.length}\n`);

console.log('═══ SECTOR SUMMARY (SPDR ETFs) ═══\n');
const SPDR = ['XLK','XLF','XLV','XLE','XLY','XLP','XLI','XLB','XLU','XLRE'];
let secOk = 0;
for (const s of SPDR) {
  const r = await yhQuote(s);
  if (r.ok) { secOk++; console.log(`  ✓ ${s.padEnd(6)} ${r.price.toFixed(2)}`); }
  else      { console.log(`  ✗ ${s.padEnd(6)} ${r.reason}`); }
  await new Promise(r => setTimeout(r, 150));
}
console.log(`  get-sector-summary               ${secOk}/${SPDR.length}\n`);

console.log('═══ FOREX (Frankfurter) ═══\n');
const fxBases = ['USD','EUR','GBP','JPY','INR'];
let fxOk = 0;
for (const b of fxBases) {
  const r = await frkFx(b);
  if (r.ok) { fxOk++; console.log(`  ✓ ${b}  ${r.count} pairs (${r.ms}ms)`); }
  else      { console.log(`  ✗ ${b}  ${r.reason}`); }
}
console.log(`  forex (Frankfurter)              ${fxOk}/${fxBases.length}\n`);

console.log('═══ MACRO / FEAR-GREED / BREADTH (FRED) ═══\n');
const fredKey = loadFredKey();
const fredSeriesIds = ['SP500','NASDAQCOM','VIXCLS','DGS10','UNRATE'];
let fredOk = 0;
for (const id of fredSeriesIds) {
  const r = await fredSeries(id, fredKey);
  if (r.ok) { fredOk++; console.log(`  ✓ ${id.padEnd(12)} ${r.ms}ms`); }
  else      { console.log(`  ✗ ${id.padEnd(12)} ${r.reason}`); }
  await new Promise(r => setTimeout(r, 100));
}
console.log(`  get-fear-greed-index, get-market-breadth-history → FRED ${fredOk}/${fredSeriesIds.length}\n`);

console.log('═'.repeat(72));
console.log('  SUMMARY — by panel');
console.log('═'.repeat(72));
console.log(`  list-crypto-quotes              ${cryptoIds.length} ids configured (CoinGecko reachable above)`);
console.log(`  list-ai-tokens                  ${aiIds.length} ids configured`);
console.log(`  list-defi-tokens                ${defiIds.length} ids configured`);
console.log(`  list-other-tokens               ${otherIds.length} ids configured`);
console.log(`  list-stablecoin-markets         ${stablecoinIds.length} ids configured`);
console.log(`  list-market-quotes              ${stockOk}/${stockSubset.length} stocks via Yahoo`);
console.log(`  list-commodity-quotes           ${comOk}/${commodityList.length} commodities via Yahoo`);
console.log(`  list-gulf-quotes                ${gulfOk}/${gulfSyms.length} gulf markets`);
console.log(`  get-sector-summary              ${secOk}/${SPDR.length} SPDR ETFs via Yahoo`);
console.log(`  forex                           ${fxOk}/${fxBases.length} Frankfurter bases`);
console.log(`  macro (FRED)                    ${fredOk}/${fredSeriesIds.length} series`);
console.log('═'.repeat(72) + '\n');
