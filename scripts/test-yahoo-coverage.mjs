#!/usr/bin/env node
/**
 * Single-source-of-truth probe: is Yahoo Finance actually usable as the only
 * data backend for stocks, crypto, forex, indices, futures, and options
 * from THIS environment?
 *
 * Hits the same v8/v7 endpoints the runtime code uses, measures per-call
 * latency, classifies failures (429 vs timeout vs not-found vs network),
 * and prints a verdict.
 *
 * Usage:  node scripts/test-yahoo-coverage.mjs
 */

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 8000;

const SUITES = {
  stocks:      ['AAPL', 'TSLA', 'AMZN', 'META', 'NVDA', 'GOOGL', 'MSFT', 'JPM'],
  crypto:      ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD'],
  forex:       ['EURUSD=X', 'USDJPY=X', 'GBPUSD=X', 'USDINR=X', 'USDCHF=X'],
  indices:     ['^GSPC', '^IXIC', '^DJI', '^VIX', '^FTSE', '^N225'],
  futures:     ['GC=F', 'CL=F', 'NG=F', 'SI=F', 'HG=F'],
  india:       ['RELIANCE.NS', 'TCS.NS', 'INFY.NS', 'TATASTEEL.NS', 'BAJFINANCE.NS'],
  gulf:        ['^TASI.SR', 'DFMGI.AE', 'XU100.IS'],
};

const HEADERS = {
  'User-Agent': CHROME_UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};

async function probeQuote(symbol) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const ms = Date.now() - t0;
    if (res.status === 429) return { ok: false, ms, status: 429, reason: 'rate-limited' };
    if (!res.ok)             return { ok: false, ms, status: res.status, reason: `HTTP ${res.status}` };
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return { ok: false, ms, reason: 'no price in payload' };
    return { ok: true, ms, price: meta.regularMarketPrice, ccy: meta.currency };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

async function probeOptions(symbol) {
  const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const ms = Date.now() - t0;
    if (res.status === 429) return { ok: false, ms, status: 429, reason: 'rate-limited' };
    if (!res.ok)             return { ok: false, ms, status: res.status, reason: `HTTP ${res.status}` };
    const json = await res.json();
    const chain = json?.optionChain?.result?.[0];
    const calls = chain?.options?.[0]?.calls?.length || 0;
    const puts  = chain?.options?.[0]?.puts?.length || 0;
    const exps  = chain?.expirationDates?.length || 0;
    if (calls + puts === 0) return { ok: false, ms, reason: 'empty options' };
    return { ok: true, ms, calls, puts, expirations: exps };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

function fmtMs(n) { return String(n).padStart(5) + 'ms'; }
function pad(s, n) { return s.padEnd(n); }

console.log('Yahoo Finance coverage probe — sequential, 8s timeout per call\n');

const summary = {};

for (const [suite, syms] of Object.entries(SUITES)) {
  console.log(`── ${suite.toUpperCase()} ──`);
  let ok = 0;
  for (const s of syms) {
    const r = await probeQuote(s);
    if (r.ok) {
      ok++;
      console.log(`  ✓ ${pad(s, 14)} ${fmtMs(r.ms)}  ${r.price?.toFixed(4)} ${r.ccy || ''}`);
    } else {
      console.log(`  ✗ ${pad(s, 14)} ${fmtMs(r.ms)}  ${r.reason}`);
    }
    // 200ms breather to avoid burst-throttling
    await new Promise(r => setTimeout(r, 200));
  }
  summary[suite] = { ok, total: syms.length };
  console.log('');
}

console.log('── OPTIONS ──');
const optionTests = ['AAPL', 'TSLA', 'NVDA'];
for (const s of optionTests) {
  const r = await probeOptions(s);
  if (r.ok) {
    console.log(`  ✓ ${pad(s, 14)} ${fmtMs(r.ms)}  ${r.calls} calls + ${r.puts} puts, ${r.expirations} expirations`);
  } else {
    console.log(`  ✗ ${pad(s, 14)} ${fmtMs(r.ms)}  ${r.reason}`);
  }
  await new Promise(r => setTimeout(r, 200));
}
console.log('');

console.log('── SUMMARY ──');
let totalOk = 0, totalAll = 0;
for (const [k, v] of Object.entries(summary)) {
  totalOk += v.ok; totalAll += v.total;
  const pct = ((v.ok / v.total) * 100).toFixed(0);
  console.log(`  ${pad(k, 12)} ${v.ok}/${v.total}  (${pct}%)`);
}
console.log(`  ${'OVERALL'.padEnd(12)} ${totalOk}/${totalAll}  (${((totalOk/totalAll)*100).toFixed(0)}%)`);
console.log('');

if (totalOk / totalAll < 0.6) {
  console.log('VERDICT: Yahoo is unreliable from this environment. Do NOT consolidate to Yahoo-only.');
  process.exit(1);
}
if (totalOk / totalAll < 0.9) {
  console.log('VERDICT: Yahoo works for most but fails on some. Use Yahoo as primary with targeted fallbacks.');
  process.exit(0);
}
console.log('VERDICT: Yahoo is reliable here. Safe to consolidate to Yahoo-only.');
process.exit(0);
