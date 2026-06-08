#!/usr/bin/env node
/**
 * Yahoo Finance probe with PROPER session handling:
 *   1. Fetch finance.yahoo.com to acquire the A1/A3/B/GUC cookies
 *   2. Fetch /v1/test/getcrumb with those cookies to get the crumb token
 *   3. Call v8/finance/chart with cookies + crumb on every request
 *
 * This is how yfinance, yahoo-fin, node-yahoo-finance2, and any
 * real-world Yahoo client bypasses the unauthenticated 429.
 */

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10_000;

const BROWSER_HEADERS = {
  'User-Agent': CHROME_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const API_HEADERS = {
  'User-Agent': CHROME_UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

/** Collect Set-Cookie headers across response.headers properly. */
function extractCookies(res) {
  // Node 22+ supports getSetCookie(); fall back to raw if needed.
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.map((c) => c.split(';')[0].trim()).filter(Boolean);
}

async function step1_getCookies() {
  console.log('Step 1: GET https://finance.yahoo.com/quote/AAPL  (priming cookies)');
  const t0 = Date.now();
  const res = await fetch('https://finance.yahoo.com/quote/AAPL', {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  console.log(`   HTTP ${res.status} in ${Date.now() - t0}ms`);
  // Yahoo's GDPR flow may redirect through guce.yahoo.com first. Follow that.
  let cookies = extractCookies(res);
  if (res.url.includes('guce.') || res.url.includes('consent')) {
    console.log('   [consent flow detected — accepting]');
    // Submit the consent form: real yfinance does this by re-requesting with
    // gpp + consent + sessionId from the response body. For probe purposes
    // we just try the direct subdomain.
    const r2 = await fetch('https://finance.yahoo.com/', {
      headers: { ...BROWSER_HEADERS, Cookie: cookies.join('; ') },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    cookies = [...cookies, ...extractCookies(r2)];
  }
  // Dedupe by name
  const byName = new Map();
  for (const c of cookies) {
    const name = c.split('=')[0];
    byName.set(name, c);
  }
  cookies = [...byName.values()];
  console.log(`   cookies received: ${cookies.length} → ${cookies.map((c) => c.split('=')[0]).join(', ')}`);
  return cookies.join('; ');
}

async function step2_getCrumb(cookie) {
  console.log('Step 2: GET https://query1.finance.yahoo.com/v1/test/getcrumb');
  const t0 = Date.now();
  const res = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { ...API_HEADERS, Cookie: cookie },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.text();
  console.log(`   HTTP ${res.status} in ${Date.now() - t0}ms  body="${body.slice(0, 60)}"`);
  if (!res.ok) return null;
  if (!body || body.includes('<') || body.length > 80) return null;
  return body.trim();
}

async function step3_probeQuote(symbol, cookie, crumb) {
  const qs = crumb ? `?interval=1d&range=5d&crumb=${encodeURIComponent(crumb)}` : '?interval=1d&range=5d';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}${qs}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { ...API_HEADERS, Cookie: cookie },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    if (res.status === 429) return { ok: false, ms, reason: '429 rate-limited' };
    if (!res.ok) return { ok: false, ms, reason: `HTTP ${res.status}` };
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return { ok: false, ms, reason: 'empty payload' };
    return { ok: true, ms, price: meta.regularMarketPrice, ccy: meta.currency };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

// ──────────────────────────────────────────────────────────────────────────────

const cookie = await step1_getCookies();
if (!cookie) {
  console.log('\nFAIL: no cookies acquired. Yahoo is probably IP-banning this host outright.');
  process.exit(2);
}
console.log('');

const crumb = await step2_getCrumb(cookie);
console.log(`   crumb: ${crumb ? `"${crumb}" (${crumb.length} chars)` : 'NONE'}`);
console.log('');

console.log('Step 3: probe data endpoints with cookie + crumb\n');
const SUITES = {
  stocks:  ['AAPL', 'TSLA', 'NVDA', 'GOOGL', 'MSFT'],
  crypto:  ['BTC-USD', 'ETH-USD', 'SOL-USD'],
  forex:   ['EURUSD=X', 'USDJPY=X', 'GBPUSD=X'],
  indices: ['^GSPC', '^IXIC', '^VIX'],
  futures: ['GC=F', 'CL=F'],
  india:   ['RELIANCE.NS', 'TATASTEEL.NS'],
};
let totalOk = 0, totalAll = 0;
for (const [suite, syms] of Object.entries(SUITES)) {
  let ok = 0;
  console.log(`── ${suite.toUpperCase()} ──`);
  for (const s of syms) {
    const r = await step3_probeQuote(s, cookie, crumb);
    totalAll++;
    if (r.ok) {
      ok++; totalOk++;
      console.log(`  ✓ ${s.padEnd(14)} ${String(r.ms).padStart(5)}ms  ${r.price.toFixed(4)} ${r.ccy || ''}`);
    } else {
      console.log(`  ✗ ${s.padEnd(14)} ${String(r.ms).padStart(5)}ms  ${r.reason}`);
    }
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`  → ${ok}/${syms.length}\n`);
}

console.log(`OVERALL: ${totalOk}/${totalAll}  (${((totalOk/totalAll)*100).toFixed(0)}%)`);
if (totalOk / totalAll >= 0.9) {
  console.log('VERDICT: Yahoo works with proper session handling. Refactor to Yahoo-only is viable.');
} else if (totalOk / totalAll >= 0.5) {
  console.log('VERDICT: Yahoo partially works. Use Yahoo with targeted fallbacks for the failures.');
} else {
  console.log('VERDICT: Yahoo still rejects this host even with session. IP is hard-banned.');
}
