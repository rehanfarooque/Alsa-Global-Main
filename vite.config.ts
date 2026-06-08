import { defineConfig, loadEnv, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve, dirname, extname } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { brotliCompress } from 'zlib';
import { promisify } from 'util';
import pkg from './package.json';
import { VARIANT_META, type VariantMeta } from './src/config/variant-meta';

// Env-dependent constants moved inside defineConfig function


const brotliCompressAsync = promisify(brotliCompress);
const BROTLI_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.txt', '.xml', '.wasm']);

// Single source of truth for chunk names that must NOT be hoisted into the
// entry HTML's modulepreload list. Used by both `manualChunks` (return values
// must literally match these strings) and `modulePreload.resolveDependencies`
// (filter regex is built from this list). Keeping them tied prevents the
// silent-breakage failure mode where renaming a chunk in `manualChunks`
// re-eagerises the WebGL stack without any build-time error.
//   - maplibre, deck-stack: heavy WebGL deps, only reachable via MapContainer
//   - MapContainer: the dynamic-import target itself
const LAZY_HTML_PRELOAD_CHUNKS = ['maplibre', 'deck-stack', 'MapContainer'] as const;
const LAZY_HTML_PRELOAD_RE = new RegExp(
  `/(${LAZY_HTML_PRELOAD_CHUNKS.join('|')})-[A-Za-z0-9_-]+\\.js$`,
);

// Panel-cluster manualChunks map. Splits the previously monolithic ~2.3MB
// `panels` chunk into per-domain chunks so cache invalidation is local to
// the cluster a panel lives in and per-variant builds can prune unused
// clusters. Unmapped panels fall through to a generic `panels` chunk.
const PANEL_CLUSTER: Record<string, string> = {
  // Markets / equities / crypto positioning
  AAIISentiment: 'panels-markets', CotPositioning: 'panels-markets',
  ETFFlows: 'panels-markets', EarningsCalendar: 'panels-markets',
  EconomicCalendar: 'panels-markets', FearGreed: 'panels-markets',
  GoldIntelligence: 'panels-markets', LiquidityShifts: 'panels-markets',
  MacroSignals: 'panels-markets', Market: 'panels-markets',
  MarketBreadth: 'panels-markets', MarketImplications: 'panels-markets',
  Positioning: 'panels-markets', Stablecoin: 'panels-markets',
  StockAnalysis: 'panels-markets', StockBacktest: 'panels-markets',
  WsbTickerScanner: 'panels-markets', YieldCurve: 'panels-markets',
  // Energy / commodities / supply infra
  ChokepointStrip: 'panels-energy', EnergyComplex: 'panels-energy',
  EnergyCrisis: 'panels-energy', EnergyDisruptions: 'panels-energy',
  EnergyRiskOverview: 'panels-energy', FuelPrices: 'panels-energy',
  FuelShortage: 'panels-energy', Hormuz: 'panels-energy',
  OilInventories: 'panels-energy', PipelineStatus: 'panels-energy',
  StorageFacilityMap: 'panels-energy', RenewableEnergy: 'panels-energy',
  // Defense / military / aviation
  AirlineIntel: 'panels-defense', DefensePatents: 'panels-defense',
  OrefSirens: 'panels-defense', StrategicPosture: 'panels-defense',
  StrategicRisk: 'panels-defense', ThermalEscalation: 'panels-defense',
  UcdpEvents: 'panels-defense',
  // News / feeds / briefs
  BreakthroughsTicker: 'panels-news', ClimateNews: 'panels-news',
  DailyMarketBrief: 'panels-news', GdeltIntel: 'panels-news',
  GoodThingsDigest: 'panels-news', LatestBrief: 'panels-news',
  LiveNews: 'panels-news', News: 'panels-news',
  PositiveNewsFeed: 'panels-news', TelegramIntel: 'panels-news',
  // Macro / prices / trade
  BigMac: 'panels-economy', ConsumerPrices: 'panels-economy',
  Economic: 'panels-economy',
  FaoFoodPriceIndex: 'panels-economy', FSI: 'panels-economy',
  GroceryBasket: 'panels-economy', GulfEconomies: 'panels-economy',
  Investments: 'panels-economy', MacroTiles: 'panels-economy',
  NationalDebt: 'panels-economy', SanctionsPressure: 'panels-economy',
  SupplyChain: 'panels-economy', TradePolicy: 'panels-economy',
  // Country briefs / signals / monitors / agent surfaces.
  // CorrelationPanel base lives here, so all *Correlation consumers MUST stay
  // in this cluster — splitting them across clusters caused TDZ on init.
  ChatAnalyst: 'panels-intel', CII: 'panels-intel',
  Cascade: 'panels-intel', Correlation: 'panels-intel',
  CountryBrief: 'panels-intel', CountryDeepDive: 'panels-intel',
  CrossSourceSignals: 'panels-intel', CustomWidget: 'panels-intel',
  Deduction: 'panels-intel',
  DisasterCorrelation: 'panels-intel',
  EconomicCorrelation: 'panels-intel',
  EscalationCorrelation: 'panels-intel',
  MilitaryCorrelation: 'panels-intel',
  Forecast: 'panels-intel',
  HeroSpotlight: 'panels-intel', Insights: 'panels-intel',
  LiveWebcams: 'panels-intel', McpData: 'panels-intel',
  Monitor: 'panels-intel', PinnedWebcams: 'panels-intel',
  Prediction: 'panels-intel', ProgressCharts: 'panels-intel',
  Regulation: 'panels-intel',
  // Disasters / climate / connectivity / society
  ClimateAnomaly: 'panels-risk', Counters: 'panels-risk',
  DiseaseOutbreaks: 'panels-risk',
  Displacement: 'panels-risk', GeoHubs: 'panels-risk',
  Giving: 'panels-risk', InternetDisruptions: 'panels-risk',
  PopulationExposure: 'panels-risk', RadiationWatch: 'panels-risk',
  RuntimeConfig: 'panels-risk', SatelliteFires: 'panels-risk',
  SecurityAdvisories: 'panels-risk', ServiceStatus: 'panels-risk',
  SocialVelocity: 'panels-risk', SpeciesComeback: 'panels-risk',
  Status: 'panels-risk', TechEvents: 'panels-risk',
  TechHubs: 'panels-risk', TechReadiness: 'panels-risk',
  WorldClock: 'panels-risk',
};

function brotliPrecompressPlugin(): Plugin {
  return {
    name: 'brotli-precompress',
    apply: 'build',
    async writeBundle(outputOptions, bundle) {
      const outDir = outputOptions.dir;
      if (!outDir) return;

      await Promise.all(Object.keys(bundle).map(async (fileName) => {
        const extension = extname(fileName).toLowerCase();
        if (!BROTLI_EXTENSIONS.has(extension)) return;

        const sourcePath = resolve(outDir, fileName);
        const compressedPath = `${sourcePath}.br`;
        const sourceBuffer = await readFile(sourcePath);
        if (sourceBuffer.length < 1024) return;

        const compressedBuffer = await brotliCompressAsync(sourceBuffer);
        await mkdir(dirname(compressedPath), { recursive: true });
        await writeFile(compressedPath, compressedBuffer);
      }));
    },
  };
}

function htmlVariantPlugin(activeMeta: VariantMeta, activeVariant: string, isDesktopBuild: boolean): Plugin {
  return {
    name: 'html-variant',
    transformIndexHtml(html) {
      let result = html
        .replace(/<title>.*?<\/title>/, `<title>${activeMeta.title}</title>`)
        .replace(/<meta name="title" content=".*?" \/>/, `<meta name="title" content="${activeMeta.title}" />`)
        .replace(/<meta name="description" content=".*?" \/>/, `<meta name="description" content="${activeMeta.description}" />`)
        .replace(/<meta name="keywords" content=".*?" \/>/, `<meta name="keywords" content="${activeMeta.keywords}" />`)
        .replace(/<link rel="canonical" href=".*?" \/>/, `<link rel="canonical" href="${activeMeta.url}" />`)
        .replace(/<meta name="application-name" content=".*?" \/>/, `<meta name="application-name" content="${activeMeta.siteName}" />`)
        .replace(/<meta property="og:url" content=".*?" \/>/, `<meta property="og:url" content="${activeMeta.url}" />`)
        .replace(/<meta property="og:title" content=".*?" \/>/, `<meta property="og:title" content="${activeMeta.title}" />`)
        .replace(/<meta property="og:description" content=".*?" \/>/, `<meta property="og:description" content="${activeMeta.description}" />`)
        .replace(/<meta property="og:site_name" content=".*?" \/>/, `<meta property="og:site_name" content="${activeMeta.siteName}" />`)
        .replace(/<meta name="subject" content=".*?" \/>/, `<meta name="subject" content="${activeMeta.subject}" />`)
        .replace(/<meta name="classification" content=".*?" \/>/, `<meta name="classification" content="${activeMeta.classification}" />`)
        .replace(/<meta name="twitter:url" content=".*?" \/>/, `<meta name="twitter:url" content="${activeMeta.url}" />`)
        .replace(/<meta name="twitter:title" content=".*?" \/>/, `<meta name="twitter:title" content="${activeMeta.title}" />`)
        .replace(/<meta name="twitter:description" content=".*?" \/>/, `<meta name="twitter:description" content="${activeMeta.description}" />`)
        .replace(/"name": "AlsaGlobal"/, `"name": "${activeMeta.siteName}"`)
        .replace(/"alternateName": "AlsaGlobal"/, `"alternateName": "${activeMeta.siteName.replace(' ', '')}"`)
        .replace(/"url": "https:\/\/worldmonitor\.app\/"/, `"url": "${activeMeta.url}"`)
        .replace(/"description": "Real-time global intelligence dashboard with live news, markets, military tracking, infrastructure monitoring, and geopolitical data."/, `"description": "${activeMeta.description}"`)
        .replace(/"featureList": \[[\s\S]*?\]/, `"featureList": ${JSON.stringify(activeMeta.features, null, 8).replace(/\n/g, '\n      ')}`);

      // Theme-color meta — warm cream for happy variant
      if (activeVariant === 'happy') {
        result = result.replace(
          /<meta name="theme-color" content=".*?" \/>/,
          '<meta name="theme-color" content="#FAFAF5" />'
        );
      }

      // Desktop builds: inject build-time variant into the inline script so data-variant is set
      // before CSS loads. Web builds always use 'full' — runtime hostname detection handles variants.
      if (activeVariant !== 'full') {
        result = result.replace(
          /if\(v\)document\.documentElement\.dataset\.variant=v;/,
          `v='${activeVariant}';document.documentElement.dataset.variant=v;`
        );
      }

      // Desktop CSP: inject localhost wildcard for dynamic sidecar port.
      // Web builds intentionally exclude localhost to avoid exposing attack surface.
      if (isDesktopBuild) {
        result = result
          .replace(
            /connect-src 'self' https: http:\/\/localhost:5173/,
            "connect-src 'self' https: http://localhost:5173 http://127.0.0.1:*"
          )
          .replace(
            /frame-src 'self'/,
            "frame-src 'self' http://127.0.0.1:*"
          );
      }

      // Desktop builds: replace favicon paths with variant-specific subdirectory.
      // Web builds use 'full' favicons in HTML; runtime JS swaps them per hostname.
      if (activeVariant !== 'full') {
        result = result
          .replace(/\/favico\/favicon/g, `/favico/${activeVariant}/favicon`)
          .replace(/\/favico\/apple-touch-icon/g, `/favico/${activeVariant}/apple-touch-icon`)
          .replace(/\/favico\/android-chrome/g, `/favico/${activeVariant}/android-chrome`)
          .replace(/\/favico\/og-image/g, `/favico/${activeVariant}/og-image`);
      }

      return result;
    },
  };
}

/**
 * AAII Sentiment bootstrap shim — serves /api/bootstrap?keys=aaiiSentiment
 * with static weekly survey data when Redis is unavailable (local dev / self-host).
 * Caches for 6 hours so the bootstrap endpoint still calls through for other keys.
 */
function aaiiBootstrapPlugin(): Plugin {
  // Recent AAII Investor Sentiment Survey snapshot (updated periodically)
  function buildAaiiData() {
    const seededAt = new Date().toISOString();
    const weeks = [
      { date: '2026-05-29', bullish: 31.6, bearish: 36.3, neutral: 32.1, spread: -4.7 },
      { date: '2026-05-22', bullish: 30.2, bearish: 37.5, neutral: 32.3, spread: -7.3 },
      { date: '2026-05-15', bullish: 28.4, bearish: 40.1, neutral: 31.5, spread: -11.7 },
      { date: '2026-05-08', bullish: 32.8, bearish: 35.9, neutral: 31.3, spread: -3.1 },
      { date: '2026-05-01', bullish: 33.4, bearish: 36.2, neutral: 30.4, spread: -2.8 },
      { date: '2026-04-24', bullish: 29.0, bearish: 40.5, neutral: 30.5, spread: -11.5 },
      { date: '2026-04-17', bullish: 26.4, bearish: 43.2, neutral: 30.4, spread: -16.8 },
      { date: '2026-04-10', bullish: 24.9, bearish: 44.8, neutral: 30.3, spread: -19.9 },
    ];
    const latest = weeks[0]!;
    const previous = weeks[1] ?? null;
    const avg8w = {
      bullish: weeks.reduce((s, w) => s + w.bullish, 0) / weeks.length,
      bearish: weeks.reduce((s, w) => s + w.bearish, 0) / weeks.length,
      neutral: weeks.reduce((s, w) => s + w.neutral, 0) / weeks.length,
      spread:  weeks.reduce((s, w) => s + w.spread, 0) / weeks.length,
    };
    return {
      seededAt,
      source: 'aaii.com (static snapshot)',
      fallback: true,
      latest,
      previous,
      avg8w: {
        bullish: Math.round(avg8w.bullish * 10) / 10,
        bearish: Math.round(avg8w.bearish * 10) / 10,
        neutral: Math.round(avg8w.neutral * 10) / 10,
        spread:  Math.round(avg8w.spread * 10) / 10,
      },
      historicalAvg: { bullish: 37.5, bearish: 31.0, neutral: 31.5 },
      extremes: { spreadBelow20: 18, bullishAbove50: 4, bearishAbove50: 12 },
      weeks,
    };
  }

  return {
    name: 'aaii-bootstrap',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/bootstrap')) return next();
        const url = new URL(req.url, 'http://localhost');
        if (!url.searchParams.get('keys')?.includes('aaiiSentiment')) return next();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'private, max-age=21600');
        res.end(JSON.stringify({ data: { aaiiSentiment: buildAaiiData() } }));
      });
    },
  };
}

/**
 * On-demand insights plugin — serves GET /api/internal/on-demand-insights.
 * Fetches live RSS headlines, generates a Gemini brief, and returns a
 * ServerInsights payload when the Redis-cached news:insights:v1 key is absent.
 * Results are cached in-process for 4 minutes to avoid hammering the Gemini API.
 */
/**
 * GOAT mode (ARGUS) Gemini Live proxy plugin.
 *
 * Upgrades client WebSocket connections to /api/goat/live and bridges them
 * to Google's Gemini Live API (bidirectional audio + tool calling). Keeps
 * GEMINI_API_KEY server-side so it never appears in client JS.
 */
/**
 * Resolve which realtime provider to use based on env vars.
 * Honors explicit LLM_REALTIME_PROVIDER first, then falls back to whichever
 * key is set. Returns null if neither key is configured.
 */
function resolveRealtimeProvider(): { provider: 'gemini' | 'openai'; apiKey: string } | null {
  const forced = (process.env.LLM_REALTIME_PROVIDER || '').toLowerCase();
  const geminiKey = process.env.GEMINI_API_KEY || '';
  const openaiKey = process.env.OPENAI_API_KEY || '';

  if (forced === 'openai' && openaiKey) return { provider: 'openai', apiKey: openaiKey };
  if (forced === 'gemini' && geminiKey) return { provider: 'gemini', apiKey: geminiKey };
  // No forced provider — prefer OpenAI if its key is set (wider regional availability),
  // otherwise Gemini.
  if (openaiKey) return { provider: 'openai', apiKey: openaiKey };
  if (geminiKey) return { provider: 'gemini', apiKey: geminiKey };
  return null;
}

const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL
  || 'gpt-4o-realtime-preview-2024-12-17';

function goatLivePlugin(): Plugin {
  return {
    name: 'goat-live',
    configureServer(server) {
      // ─── /api/goat/key — surface key + provider name to client ────────────
      // Browser learns which wire protocol to speak (Gemini Live vs OpenAI
      // Realtime). The `key` field stays in the response for the legacy
      // generateContent path, but the realtime WebSocket auth happens
      // server-side so the browser doesn't see the upstream key.
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/api/goat/key') return next();
        res.setHeader('Content-Type', 'application/json');
        const resolved = resolveRealtimeProvider();
        if (!resolved) {
          res.statusCode = 503;
          res.end(JSON.stringify({
            error: 'No realtime API key set. Add GEMINI_API_KEY or OPENAI_API_KEY to .env.',
          }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({
          provider: resolved.provider,
          // `key` kept for backwards-compat with older clients that probe presence.
          // The real upstream auth happens server-side inside the WS proxy.
          key: resolved.apiKey,
        }));
      });

      const httpServer = server.httpServer;
      if (!httpServer) return;

      let WebSocketServer: typeof import('ws').WebSocketServer | null = null;
      let WS: typeof import('ws').WebSocket | null = null;

      httpServer.on('upgrade', async (req, socket, head) => {
        if (!req.url?.startsWith('/api/goat/live')) return;

        const resolved = resolveRealtimeProvider();
        if (!resolved) {
          console.error('[goat-live] No realtime provider key set');
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\nGEMINI_API_KEY or OPENAI_API_KEY required');
          socket.destroy();
          return;
        }
        const { provider, apiKey } = resolved;
        console.log(`[goat-live] WebSocket upgrade — provider=${provider}`);

        if (!WebSocketServer) {
          const wsModule = await import('ws');
          WebSocketServer = wsModule.WebSocketServer;
          WS = wsModule.WebSocket;
        }

        const upstreamUrl = provider === 'openai'
          ? `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`
          : `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
        const upstreamHeaders = provider === 'openai'
          ? { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'realtime=v1' }
          : undefined;

        // Some VPS providers' IPv6 ranges are flagged by Google's geo-IP
        // (and others') as "unsupported region" even when the IPv4 address
        // sits in a supported country. FORCE_IPV4_UPSTREAM=1 in .env makes
        // the upstream socket resolve A records only, so the request goes
        // out over the (correctly-geolocated) IPv4 address.
        const forceIpv4 = process.env.FORCE_IPV4_UPSTREAM === '1'
          || process.env.FORCE_IPV4_UPSTREAM === 'true';

        const wss = new WebSocketServer!({ noServer: true });
        wss.handleUpgrade(req, socket as import('net').Socket, head, (clientWs) => {
          console.log(`[goat-live] Client connected, opening upstream to ${provider}${forceIpv4 ? ' (IPv4 forced)' : ''}`);
          const upstreamConnectStartedAt = Date.now();
          const upstreamWs = new WS!(upstreamUrl, {
            headers: upstreamHeaders,
            maxPayload: 64 * 1024 * 1024,
            // ws forwards these to the underlying tls/net socket; family=4
            // restricts DNS to A records (IPv4 only).
            ...(forceIpv4 ? { family: 4 } : {}),
          });

          const pendingFromClient: Array<Buffer | string> = [];
          let upstreamOpen = false;
          let closed = false;
          let msgFromClient = 0;
          let msgFromUpstream = 0;

          // ── Upstream-connect watchdog ────────────────────────────────────
          // If the upstream WS doesn't open within 8s, tell the client what
          // happened instead of letting them hang on CONNECTING. The client
          // already has a 12s setup-complete watchdog, but this catches the
          // "TCP can't even establish" case earlier with a precise reason.
          const upstreamOpenTimeout = setTimeout(() => {
            if (upstreamOpen || closed) return;
            const elapsed = Date.now() - upstreamConnectStartedAt;
            console.warn(`[goat-live] upstream WS hasn't opened after ${elapsed}ms — network/DNS/TLS issue?`);
            try {
              clientWs.send(JSON.stringify({
                _proxyError: {
                  reason: 'upstream-connect-timeout',
                  message: `Could not reach ${provider} realtime within ${elapsed}ms. Check network/firewall/HTTPS_PROXY.`,
                  elapsedMs: elapsed,
                },
              }));
            } catch { /* ignore */ }
            cleanup('upstream-connect-timeout');
          }, 8_000);

          const cleanup = (reason: string) => {
            if (closed) return;
            closed = true;
            clearTimeout(upstreamOpenTimeout);
            console.log(`[goat-live] Cleanup: ${reason} (client msgs: ${msgFromClient}, upstream msgs: ${msgFromUpstream})`);
            try { clientWs.close(1011, reason); } catch { /* ignore */ }
            try { upstreamWs.close(1011, reason); } catch { /* ignore */ }
          };

          upstreamWs.on('open', () => {
            const elapsed = Date.now() - upstreamConnectStartedAt;
            console.log(`[goat-live] Upstream ${provider} WS open (${elapsed}ms)`);
            clearTimeout(upstreamOpenTimeout);
            upstreamOpen = true;
            for (const msg of pendingFromClient) {
              try { upstreamWs.send(msg); } catch { /* ignore */ }
            }
            pendingFromClient.length = 0;
          });

          upstreamWs.on('message', (data, isBinary) => {
            msgFromUpstream++;
            if (msgFromUpstream <= 3) {
              // Log first 3 upstream messages to verify protocol
              try {
                const text = isBinary ? '' : data.toString();
                console.log(`[goat-live] upstream msg #${msgFromUpstream}:`, text.slice(0, 300));
              } catch { /* ignore */ }
            }
            if (clientWs.readyState === 1) {
              clientWs.send(data, { binary: isBinary });
            }
          });

          upstreamWs.on('close', (code, reason) => {
            const reasonText = reason?.toString() || '';
            console.log(`[goat-live] Upstream closed: ${code} "${reasonText}"`);
            // Forward the close reason to the client so the UI can show it
            try {
              clientWs.send(JSON.stringify({
                _proxyError: {
                  reason: 'upstream-closed',
                  code,
                  message: reasonText || `Upstream closed with code ${code}`,
                },
              }));
            } catch { /* ignore */ }
            cleanup('upstream-closed');
          });
          upstreamWs.on('error', (err) => {
            console.warn('[goat-live] upstream error:', err.message, err.stack?.split('\n')[1]?.trim() || '');
            try {
              clientWs.send(JSON.stringify({
                _proxyError: {
                  reason: 'upstream-error',
                  message: err.message,
                },
              }));
            } catch { /* ignore */ }
            cleanup('upstream-error');
          });

          clientWs.on('message', (data, isBinary) => {
            msgFromClient++;
            if (msgFromClient === 1) {
              try {
                console.log('[goat-live] first client msg:', data.toString().slice(0, 400));
              } catch { /* ignore */ }
            }
            if (!upstreamOpen) {
              pendingFromClient.push(isBinary ? (data as Buffer) : data.toString());
              return;
            }
            try { upstreamWs.send(data, { binary: isBinary }); } catch { /* ignore */ }
          });

          clientWs.on('close', () => cleanup('client-closed'));
          clientWs.on('error', (err) => {
            console.warn('[goat-live] client error:', err.message);
            cleanup('client-error');
          });
        });
      });
    },
  };
}

/**
 * Widget agent plugin — serves /widget-agent (health + generate).
 * Uses Gemini to generate self-contained HTML widgets streamed as SSE.
 */
function widgetAgentPlugin(): Plugin {
  return {
    name: 'widget-agent',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        const method = req.method ?? 'GET';

        // Health check
        if ((url === '/widget-agent/health' || url === '/widget-agent') && method === 'GET') {
          const apiKey = process.env.GEMINI_API_KEY;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.statusCode = 200;
          res.end(JSON.stringify({ ok: true, proKeyConfigured: !!apiKey, provider: 'gemini' }));
          return;
        }

        if (url !== '/widget-agent' || method !== 'POST') return next();

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'GEMINI_API_KEY not set' }));
          return;
        }

        // Parse body
        let body: { prompt?: string; mode?: string; currentHtml?: string; conversationHistory?: Array<{ role: string; content: string }> } = {};
        try {
          const chunks: Buffer[] = [];
          await new Promise<void>((resolve, reject) => {
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', resolve);
            req.on('error', reject);
          });
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch { /* use empty body */ }

        const prompt = (body.prompt ?? '').slice(0, 2000).trim();
        if (!prompt) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'No prompt' }));
          return;
        }

        // Set up SSE
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-Accel-Buffering', 'no');

        const send = (event: Record<string, unknown>) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        };

        send({ type: 'tool_call', endpoint: 'Generating widget with Gemini...' });

        const systemPrompt = `You are an expert frontend developer creating self-contained HTML widgets for a global intelligence dashboard.

Generate a single complete HTML file that:
1. Uses only inline CSS and vanilla JavaScript (no external imports EXCEPT Chart.js from https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js if charts are needed)
2. Has a dark theme matching: background #0d1117, text #e6edf3, accent #58a6ff, border #21262d
3. Uses a clean, professional design with subtle gradients/shadows
4. Shows realistic, plausible data values relevant to the widget type
5. Is interactive (hover effects, tooltips, clickable tabs if relevant)
6. Fits naturally in a dashboard panel (no <html><head><body> wrapper needed — just the content div with embedded <style> and <script>)
7. Has a title bar matching the dark theme

CRITICAL: Return ONLY the raw HTML. No markdown, no code fences, no explanation. Start directly with the HTML content.`;

        const history = (body.conversationHistory ?? []).map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

        const modifyContext = body.currentHtml
          ? `\n\nCurrent widget HTML to modify:\n${body.currentHtml.slice(0, 8000)}`
          : '';

        const geminiPayload = {
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [
            ...history,
            { role: 'user', parts: [{ text: `${prompt}${modifyContext}` }] },
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 8192,
          },
        };

        const model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        try {
          const geminiResp = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiPayload),
            signal: AbortSignal.timeout(90_000),
          });

          if (!geminiResp.ok) {
            const errText = await geminiResp.text().catch(() => '');
            throw new Error(`Gemini HTTP ${geminiResp.status}: ${errText.slice(0, 200)}`);
          }

          const geminiData = await geminiResp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
          let html = geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

          // Strip markdown code fences if model wrapped it
          html = html.replace(/^```html?\s*/i, '').replace(/\s*```$/, '').trim();

          if (!html) throw new Error('Gemini returned empty content');

          // Extract title from HTML or use prompt
          const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i) || html.match(/<h[12][^>]*>([^<]+)<\/h[12]>/i);
          const title = titleMatch ? titleMatch[1]!.trim().slice(0, 60) : prompt.slice(0, 60);

          send({ type: 'html_complete', html });
          send({ type: 'done', title });
        } catch (err) {
          send({ type: 'error', message: (err as Error).message });
        }

        res.end();
      });
    },
  };
}

function onDemandInsightsPlugin(): Plugin {
  let lastGenAt = 0;
  let inFlight: Promise<unknown> | null = null;
  let cachedPayload: unknown = null;
  const CACHE_MS = 4 * 60 * 1000;

  return {
    name: 'on-demand-insights',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/api/internal/on-demand-insights') return next();

        const now = Date.now();
        const headers = {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'private, max-age=240',
        };

        // Return cached result if fresh
        if (cachedPayload && now - lastGenAt < CACHE_MS) {
          res.statusCode = 200;
          for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
          res.end(JSON.stringify(cachedPayload));
          return;
        }

        // Deduplicate concurrent requests
        if (!inFlight) {
          inFlight = import('./server/alsaglobal/intelligence/v1/get-on-demand-insights')
            .then(m => m.getOnDemandInsights())
            .then(data => {
              if (data) { cachedPayload = data; lastGenAt = Date.now(); }
              inFlight = null;
              return data;
            })
            .catch(() => { inFlight = null; return null; });
        }

        try {
          const data = await inFlight;
          if (!data) {
            res.statusCode = 503;
            for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
            res.end(JSON.stringify({ error: 'Could not generate insights' }));
            return;
          }
          res.statusCode = 200;
          for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
          res.end(JSON.stringify(data));
        } catch {
          res.statusCode = 500;
          for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
          res.end(JSON.stringify({ error: 'Internal error' }));
        }
      });
    },
  };
}

function polymarketPlugin(): Plugin {
  const GAMMA_BASE = 'https://gamma-api.polymarket.com';
  const ALLOWED_ORDER = ['volume', 'liquidity', 'startDate', 'endDate', 'spread'];

  return {
    name: 'polymarket-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/polymarket')) return next();

        const url = new URL(req.url, 'http://localhost');
        const endpoint = url.searchParams.get('endpoint') || 'markets';
        const closed = ['true', 'false'].includes(url.searchParams.get('closed') ?? '') ? url.searchParams.get('closed') : 'false';
        const order = ALLOWED_ORDER.includes(url.searchParams.get('order') ?? '') ? url.searchParams.get('order') : 'volume';
        const ascending = ['true', 'false'].includes(url.searchParams.get('ascending') ?? '') ? url.searchParams.get('ascending') : 'false';
        const rawLimit = parseInt(url.searchParams.get('limit') ?? '', 10);
        const limit = isNaN(rawLimit) ? 50 : Math.max(1, Math.min(100, rawLimit));

        const params = new URLSearchParams({ closed: closed!, order: order!, ascending: ascending!, limit: String(limit) });
        if (endpoint === 'events') {
          const tag = (url.searchParams.get('tag') ?? '').replace(/[^a-z0-9-]/gi, '').slice(0, 100);
          if (tag) params.set('tag_slug', tag);
        }

        const gammaUrl = `${GAMMA_BASE}/${endpoint === 'events' ? 'events' : 'markets'}?${params}`;

        res.setHeader('Content-Type', 'application/json');
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          const resp = await fetch(gammaUrl, { headers: { Accept: 'application/json' }, signal: controller.signal });
          clearTimeout(timer);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.text();
          res.setHeader('Cache-Control', 'public, max-age=120');
          res.setHeader('X-Polymarket-Source', 'gamma');
          res.end(data);
        } catch {
          // Expected: Cloudflare JA3 blocks server-side TLS — return empty array
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.end('[]');
        }
      });
    },
  };
}

/**
 * Vite dev server plugin for sebuf API routes.
 *
 * Intercepts requests matching /api/{domain}/v1/* and routes them through
 * the same handler pipeline as the Vercel catch-all gateway. Other /api/*
 * paths fall through to existing proxy rules.
 */
function sebufApiPlugin(): Plugin {
  // Cache router across requests (H-13 fix). Invalidated by Vite's module graph on HMR.
  let cachedRouter: Awaited<ReturnType<typeof buildRouter>> | null = null;
  let cachedCorsMod: any = null;

  async function buildRouter() {
    const [
      routerMod, corsMod, errorMod,
      seismologyServerMod, seismologyHandlerMod,
      wildfireServerMod, wildfireHandlerMod,
      climateServerMod, climateHandlerMod,
      predictionServerMod, predictionHandlerMod,
      displacementServerMod, displacementHandlerMod,
      aviationServerMod, aviationHandlerMod,
      researchServerMod, researchHandlerMod,
      unrestServerMod, unrestHandlerMod,
      conflictServerMod, conflictHandlerMod,
      maritimeServerMod, maritimeHandlerMod,
      cyberServerMod, cyberHandlerMod,
      economicServerMod, economicHandlerMod,
      infrastructureServerMod, infrastructureHandlerMod,
      marketServerMod, marketHandlerMod,
      newsServerMod, newsHandlerMod,
      intelligenceServerMod, intelligenceHandlerMod,
      militaryServerMod, militaryHandlerMod,
      positiveEventsServerMod, positiveEventsHandlerMod,
      givingServerMod, givingHandlerMod,
      tradeServerMod, tradeHandlerMod,
      supplyChainServerMod, supplyChainHandlerMod,
      naturalServerMod, naturalHandlerMod,
      resilienceServerMod, resilienceHandlerMod,
      leadsServerMod, leadsHandlerMod,
      scenarioServerMod, scenarioHandlerMod,
      shippingV2ServerMod, shippingV2HandlerMod,
      healthServerMod, healthHandlerMod,
      consumerPricesServerMod, consumerPricesHandlerMod,
      forecastServerMod, forecastHandlerMod,
      imageryServerMod, imageryHandlerMod,
      radiationServerMod, radiationHandlerMod,
      sanctionsServerMod, sanctionsHandlerMod,
      thermalServerMod, thermalHandlerMod,
      webcamServerMod, webcamHandlerMod,
    ] = await Promise.all([
        import('./server/router'),
        import('./server/cors'),
        import('./server/error-mapper'),
        import('./src/generated/server/alsaglobal/seismology/v1/service_server'),
        import('./server/alsaglobal/seismology/v1/handler'),
        import('./src/generated/server/alsaglobal/wildfire/v1/service_server'),
        import('./server/alsaglobal/wildfire/v1/handler'),
        import('./src/generated/server/alsaglobal/climate/v1/service_server'),
        import('./server/alsaglobal/climate/v1/handler'),
        import('./src/generated/server/alsaglobal/prediction/v1/service_server'),
        import('./server/alsaglobal/prediction/v1/handler'),
        import('./src/generated/server/alsaglobal/displacement/v1/service_server'),
        import('./server/alsaglobal/displacement/v1/handler'),
        import('./src/generated/server/alsaglobal/aviation/v1/service_server'),
        import('./server/alsaglobal/aviation/v1/handler'),
        import('./src/generated/server/alsaglobal/research/v1/service_server'),
        import('./server/alsaglobal/research/v1/handler'),
        import('./src/generated/server/alsaglobal/unrest/v1/service_server'),
        import('./server/alsaglobal/unrest/v1/handler'),
        import('./src/generated/server/alsaglobal/conflict/v1/service_server'),
        import('./server/alsaglobal/conflict/v1/handler'),
        import('./src/generated/server/alsaglobal/maritime/v1/service_server'),
        import('./server/alsaglobal/maritime/v1/handler'),
        import('./src/generated/server/alsaglobal/cyber/v1/service_server'),
        import('./server/alsaglobal/cyber/v1/handler'),
        import('./src/generated/server/alsaglobal/economic/v1/service_server'),
        import('./server/alsaglobal/economic/v1/handler'),
        import('./src/generated/server/alsaglobal/infrastructure/v1/service_server'),
        import('./server/alsaglobal/infrastructure/v1/handler'),
        import('./src/generated/server/alsaglobal/market/v1/service_server'),
        import('./server/alsaglobal/market/v1/handler'),
        import('./src/generated/server/alsaglobal/news/v1/service_server'),
        import('./server/alsaglobal/news/v1/handler'),
        import('./src/generated/server/alsaglobal/intelligence/v1/service_server'),
        import('./server/alsaglobal/intelligence/v1/handler'),
        import('./src/generated/server/alsaglobal/military/v1/service_server'),
        import('./server/alsaglobal/military/v1/handler'),
        import('./src/generated/server/alsaglobal/positive_events/v1/service_server'),
        import('./server/alsaglobal/positive-events/v1/handler'),
        import('./src/generated/server/alsaglobal/giving/v1/service_server'),
        import('./server/alsaglobal/giving/v1/handler'),
        import('./src/generated/server/alsaglobal/trade/v1/service_server'),
        import('./server/alsaglobal/trade/v1/handler'),
        import('./src/generated/server/alsaglobal/supply_chain/v1/service_server'),
        import('./server/alsaglobal/supply-chain/v1/handler'),
        import('./src/generated/server/alsaglobal/natural/v1/service_server'),
        import('./server/alsaglobal/natural/v1/handler'),
        import('./src/generated/server/alsaglobal/resilience/v1/service_server'),
        import('./server/alsaglobal/resilience/v1/handler'),
        import('./src/generated/server/alsaglobal/leads/v1/service_server'),
        import('./server/alsaglobal/leads/v1/handler'),
        import('./src/generated/server/alsaglobal/scenario/v1/service_server'),
        import('./server/alsaglobal/scenario/v1/handler'),
        import('./src/generated/server/alsaglobal/shipping/v2/service_server'),
        import('./server/alsaglobal/shipping/v2/handler'),
        import('./src/generated/server/alsaglobal/health/v1/service_server'),
        import('./server/alsaglobal/health/v1/handler'),
        import('./src/generated/server/alsaglobal/consumer_prices/v1/service_server'),
        import('./server/alsaglobal/consumer-prices/v1/handler'),
        import('./src/generated/server/alsaglobal/forecast/v1/service_server'),
        import('./server/alsaglobal/forecast/v1/handler'),
        import('./src/generated/server/alsaglobal/imagery/v1/service_server'),
        import('./server/alsaglobal/imagery/v1/handler'),
        import('./src/generated/server/alsaglobal/radiation/v1/service_server'),
        import('./server/alsaglobal/radiation/v1/handler'),
        import('./src/generated/server/alsaglobal/sanctions/v1/service_server'),
        import('./server/alsaglobal/sanctions/v1/handler'),
        import('./src/generated/server/alsaglobal/thermal/v1/service_server'),
        import('./server/alsaglobal/thermal/v1/handler'),
        import('./src/generated/server/alsaglobal/webcam/v1/service_server'),
        import('./server/alsaglobal/webcam/v1/handler'),
      ]);

    const serverOptions = { onError: errorMod.mapErrorToResponse };
    const allRoutes = [
      ...seismologyServerMod.createSeismologyServiceRoutes(seismologyHandlerMod.seismologyHandler, serverOptions),
      ...wildfireServerMod.createWildfireServiceRoutes(wildfireHandlerMod.wildfireHandler, serverOptions),
      ...climateServerMod.createClimateServiceRoutes(climateHandlerMod.climateHandler, serverOptions),
      ...predictionServerMod.createPredictionServiceRoutes(predictionHandlerMod.predictionHandler, serverOptions),
      ...displacementServerMod.createDisplacementServiceRoutes(displacementHandlerMod.displacementHandler, serverOptions),
      ...aviationServerMod.createAviationServiceRoutes(aviationHandlerMod.aviationHandler, serverOptions),
      ...researchServerMod.createResearchServiceRoutes(researchHandlerMod.researchHandler, serverOptions),
      ...unrestServerMod.createUnrestServiceRoutes(unrestHandlerMod.unrestHandler, serverOptions),
      ...conflictServerMod.createConflictServiceRoutes(conflictHandlerMod.conflictHandler, serverOptions),
      ...maritimeServerMod.createMaritimeServiceRoutes(maritimeHandlerMod.maritimeHandler, serverOptions),
      ...cyberServerMod.createCyberServiceRoutes(cyberHandlerMod.cyberHandler, serverOptions),
      ...economicServerMod.createEconomicServiceRoutes(economicHandlerMod.economicHandler, serverOptions),
      ...infrastructureServerMod.createInfrastructureServiceRoutes(infrastructureHandlerMod.infrastructureHandler, serverOptions),
      ...marketServerMod.createMarketServiceRoutes(marketHandlerMod.marketHandler, serverOptions),
      ...newsServerMod.createNewsServiceRoutes(newsHandlerMod.newsHandler, serverOptions),
      ...intelligenceServerMod.createIntelligenceServiceRoutes(intelligenceHandlerMod.intelligenceHandler, serverOptions),
      ...militaryServerMod.createMilitaryServiceRoutes(militaryHandlerMod.militaryHandler, serverOptions),
      ...positiveEventsServerMod.createPositiveEventsServiceRoutes(positiveEventsHandlerMod.positiveEventsHandler, serverOptions),
      ...givingServerMod.createGivingServiceRoutes(givingHandlerMod.givingHandler, serverOptions),
      ...tradeServerMod.createTradeServiceRoutes(tradeHandlerMod.tradeHandler, serverOptions),
      ...supplyChainServerMod.createSupplyChainServiceRoutes(supplyChainHandlerMod.supplyChainHandler, serverOptions),
      ...naturalServerMod.createNaturalServiceRoutes(naturalHandlerMod.naturalHandler, serverOptions),
      ...resilienceServerMod.createResilienceServiceRoutes(resilienceHandlerMod.resilienceHandler, serverOptions),
      ...leadsServerMod.createLeadsServiceRoutes(leadsHandlerMod.leadsHandler, serverOptions),
      ...scenarioServerMod.createScenarioServiceRoutes(scenarioHandlerMod.scenarioHandler, serverOptions),
      ...shippingV2ServerMod.createShippingV2ServiceRoutes(shippingV2HandlerMod.shippingV2Handler, serverOptions),
      ...healthServerMod.createHealthServiceRoutes(healthHandlerMod.healthHandler, serverOptions),
      ...consumerPricesServerMod.createConsumerPricesServiceRoutes(consumerPricesHandlerMod.consumerPricesHandler, serverOptions),
      ...forecastServerMod.createForecastServiceRoutes(forecastHandlerMod.forecastHandler, serverOptions),
      ...imageryServerMod.createImageryServiceRoutes(imageryHandlerMod.imageryHandler, serverOptions),
      ...radiationServerMod.createRadiationServiceRoutes(radiationHandlerMod.radiationHandler, serverOptions),
      ...sanctionsServerMod.createSanctionsServiceRoutes(sanctionsHandlerMod.sanctionsHandler, serverOptions),
      ...thermalServerMod.createThermalServiceRoutes(thermalHandlerMod.thermalHandler, serverOptions),
      ...webcamServerMod.createWebcamServiceRoutes(webcamHandlerMod.webcamHandler, serverOptions),
    ];
    cachedCorsMod = corsMod;
    return routerMod.createRouter(allRoutes);
  }

  return {
    name: 'sebuf-api',
    configureServer(server) {
      // Invalidate cached router on HMR updates to server/ files
      server.watcher.on('change', (file) => {
        if (file.includes('/server/') || file.includes('/src/generated/server/')) {
          cachedRouter = null;
        }
      });

      // Legacy v1 URL aliases → new sebuf RPC paths (mirror of the alias files
      // in api/scenario/v1/ + api/supply-chain/v1/). Vercel serves the alias
      // files directly; vite dev has no file-based routing for api/, so we
      // rewrite the pathname here before the router lookup.
      const V1_ALIASES: Record<string, string> = {
        '/api/scenario/v1/run': '/api/scenario/v1/run-scenario',
        '/api/scenario/v1/status': '/api/scenario/v1/get-scenario-status',
        '/api/scenario/v1/templates': '/api/scenario/v1/list-scenario-templates',
        '/api/supply-chain/v1/country-products': '/api/supply-chain/v1/get-country-products',
        '/api/supply-chain/v1/multi-sector-cost-shock': '/api/supply-chain/v1/get-multi-sector-cost-shock',
      };

      server.middlewares.use(async (req, res, next) => {
        // Intercept sebuf routes in two forms:
        //  - standard /api/{domain}/v{N}/* (domain-first, e.g. /api/market/v1/...)
        //  - partner-URL-preservation /api/v{N}/{domain}/* (version-first, e.g.
        //    /api/v2/shipping/...). Only the second form applies when the
        //    external contract already uses a reversed layout.
        if (!req.url || !/^\/api\/(?:[a-z][a-z0-9-]*\/v\d+|v\d+\/[a-z][a-z0-9-]*)\//.test(req.url)) {
          return next();
        }

        // Rewrite documented v1 URL → new sebuf path if this is an alias.
        const [pathOnly, queryOnly] = req.url.split('?', 2);
        const aliasTarget = pathOnly ? V1_ALIASES[pathOnly] : undefined;
        if (aliasTarget) {
          req.url = queryOnly ? `${aliasTarget}?${queryOnly}` : aliasTarget;
        }

        try {
          // Build router once, reuse across requests (H-13 fix)
          if (!cachedRouter) {
            cachedRouter = await buildRouter();
          }
          const router = cachedRouter;
          const corsMod = cachedCorsMod;

          // Convert Connect IncomingMessage to Web Standard Request
          const port = server.config.server.port || 3000;
          const url = new URL(req.url, `http://localhost:${port}`);

          // Read body for POST requests
          let body: string | undefined;
          if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            }
            body = Buffer.concat(chunks).toString();
          }

          // Extract headers from IncomingMessage
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') {
              headers[key] = value;
            } else if (Array.isArray(value)) {
              headers[key] = value.join(', ');
            }
          }

          const webRequest = new Request(url.toString(), {
            method: req.method,
            headers,
            body: body || undefined,
          });

          const corsHeaders = corsMod.getCorsHeaders(webRequest);

          // OPTIONS preflight
          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            for (const [key, value] of Object.entries(corsHeaders)) {
              res.setHeader(key, value);
            }
            res.end();
            return;
          }

          // Origin check
          if (corsMod.isDisallowedOrigin(webRequest)) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            for (const [key, value] of Object.entries(corsHeaders)) {
              res.setHeader(key, value);
            }
            res.end(JSON.stringify({ error: 'Origin not allowed' }));
            return;
          }

          // Route matching
          const matchedHandler = router.match(webRequest);
          if (!matchedHandler) {
            const allowed = router.allowedMethods(new URL(webRequest.url).pathname);
            if (allowed.length > 0) {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Allow', allowed.join(', '));
            } else {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
            }
            for (const [key, value] of Object.entries(corsHeaders)) {
              res.setHeader(key, value);
            }
            res.end(JSON.stringify({ error: res.statusCode === 405 ? 'Method not allowed' : 'Not found' }));
            return;
          }

          // Execute handler
          const response = await matchedHandler(webRequest);

          // Write response
          res.statusCode = response.status;
          response.headers.forEach((value, key) => {
            res.setHeader(key, value);
          });
          for (const [key, value] of Object.entries(corsHeaders)) {
            res.setHeader(key, value);
          }
          res.end(await response.text());
        } catch (err) {
          console.error('[sebuf-api] Error:', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    },
  };
}

// RSS proxy allowlist — duplicated from api/rss-proxy.js for dev mode.
// Keep in sync when adding new domains.
const RSS_PROXY_ALLOWED_DOMAINS = new Set([
  'feeds.bbci.co.uk', 'www.theguardian.com', 'feeds.npr.org', 'news.google.com',
  'www.aljazeera.com', 'rss.cnn.com', 'hnrss.org', 'feeds.arstechnica.com',
  'www.theverge.com', 'www.cnbc.com', 'feeds.marketwatch.com', 'www.defenseone.com',
  'breakingdefense.com', 'www.bellingcat.com', 'techcrunch.com', 'huggingface.co',
  'www.technologyreview.com', 'rss.arxiv.org', 'export.arxiv.org',
  'www.federalreserve.gov', 'www.sec.gov', 'www.whitehouse.gov', 'www.state.gov',
  'www.defense.gov', 'home.treasury.gov', 'www.justice.gov', 'tools.cdc.gov',
  'www.fema.gov', 'www.dhs.gov', 'www.thedrive.com', 'krebsonsecurity.com',
  'finance.yahoo.com', 'thediplomat.com', 'venturebeat.com', 'foreignpolicy.com',
  'www.ft.com', 'openai.com', 'www.reutersagency.com', 'feeds.reuters.com',
  'asia.nikkei.com', 'www.cfr.org', 'www.csis.org', 'www.politico.com',
  'www.brookings.edu', 'layoffs.fyi', 'www.defensenews.com', 'www.militarytimes.com',
  'taskandpurpose.com', 'news.usni.org', 'www.oryxspioenkop.com', 'www.gov.uk',
  'www.foreignaffairs.com', 'www.atlanticcouncil.org',
  // Tech variant
  'www.zdnet.com', 'www.techmeme.com', 'www.darkreading.com', 'www.schneier.com',
  'rss.politico.com', 'www.anandtech.com', 'www.tomshardware.com', 'www.semianalysis.com',
  'feed.infoq.com', 'thenewstack.io', 'devops.com', 'dev.to', 'lobste.rs', 'changelog.com',
  'seekingalpha.com', 'news.crunchbase.com', 'www.saastr.com', 'feeds.feedburner.com',
  'www.producthunt.com', 'www.axios.com', 'api.axios.com', 'github.blog', 'githubnext.com',
  'mshibanami.github.io', 'www.engadget.com', 'news.mit.edu', 'dev.events',
  'www.ycombinator.com', 'a16z.com', 'review.firstround.com', 'www.sequoiacap.com',
  'www.nfx.com', 'www.aaronsw.com', 'bothsidesofthetable.com', 'www.lennysnewsletter.com',
  'stratechery.com', 'www.eu-startups.com', 'tech.eu', 'sifted.eu', 'www.techinasia.com',
  'kr-asia.com', 'techcabal.com', 'disrupt-africa.com', 'lavca.org', 'contxto.com',
  'inc42.com', 'yourstory.com', 'pitchbook.com', 'www.cbinsights.com', 'www.techstars.com',
  // Regional & international
  'english.alarabiya.net', 'www.arabnews.com', 'www.timesofisrael.com', 'www.haaretz.com',
  'www.scmp.com', 'kyivindependent.com', 'www.themoscowtimes.com', 'feeds.24.com',
  'feeds.capi24.com', 'www.france24.com', 'www.euronews.com', 'www.lemonde.fr',
  'rss.dw.com', 'www.africanews.com', 'www.lasillavacia.com', 'www.channelnewsasia.com',
  'www.thehindu.com', 'news.un.org', 'www.iaea.org', 'www.who.int', 'www.cisa.gov',
  'www.crisisgroup.org',
  // Think tanks
  'rusi.org', 'warontherocks.com', 'www.aei.org', 'responsiblestatecraft.org',
  'www.fpri.org', 'jamestown.org', 'www.chathamhouse.org', 'ecfr.eu', 'www.gmfus.org',
  'www.wilsoncenter.org', 'www.lowyinstitute.org', 'www.mei.edu', 'www.stimson.org',
  'www.cnas.org', 'carnegieendowment.org', 'www.rand.org', 'fas.org',
  'www.armscontrol.org', 'www.nti.org', 'thebulletin.org', 'www.iss.europa.eu',
  // Economic & Food Security
  'www.fao.org', 'worldbank.org', 'www.imf.org',
  // Regional locale feeds
  'www.hurriyet.com.tr', 'tvn24.pl', 'www.polsatnews.pl', 'www.rp.pl', 'meduza.io',
  'novayagazeta.eu', 'www.bangkokpost.com', 'vnexpress.net', 'www.abc.net.au',
  'news.ycombinator.com',
  // Hungarian / Central European feeds
  'telex.hu', 'index.hu', 'hvg.hu', '444.hu', '24.hu', 'hirado.hu', 'portfolio.hu', 'www.portfolio.hu', 'www.atv.hu',
  // Croatian feeds
  'n1info.hr', 'www.index.hr', 'www.jutarnji.hr', 'balkaninsight.com',
  // Finance variant
  'www.coindesk.com', 'cointelegraph.com',
  // Happy variant — positive news sources
  'www.goodnewsnetwork.org', 'www.positive.news', 'reasonstobecheerful.world',
  'www.optimistdaily.com', 'www.sunnyskyz.com', 'www.huffpost.com',
  'www.sciencedaily.com', 'feeds.nature.com', 'www.livescience.com', 'www.newscientist.com',
  // Feed-registry coverage (PR fix/feed-validation-unblock — kept sync with shared/rss-allowed-domains.json)
  'abcnews.go.com', 'abcnews.com', 'www.corriere.it', 'www.rt.com', 'www.alarabiya.net', 'tuoitrenews.vn',
  'www.yonhapnewstv.co.kr', 'www.chosun.com', 'rss.libsyn.com', 'feeds.megaphone.fm', 'rss.art19.com',
  'idp.nature.com',
]);

function rssProxyPlugin(): Plugin {
  return {
    name: 'rss-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/rss-proxy')) {
          return next();
        }

        const url = new URL(req.url, 'http://localhost');
        const feedUrl = url.searchParams.get('url');
        if (!feedUrl) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing url parameter' }));
          return;
        }

        try {
          const parsed = new URL(feedUrl);
          if (!RSS_PROXY_ALLOWED_DOMAINS.has(parsed.hostname)) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: `Domain not allowed: ${parsed.hostname}` }));
            return;
          }

          const controller = new AbortController();
          const timeout = feedUrl.includes('news.google.com') ? 20000 : 12000;
          const timer = setTimeout(() => controller.abort(), timeout);

          const response = await fetch(feedUrl, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            },
            redirect: 'follow',
          });
          clearTimeout(timer);

          const data = await response.text();
          res.statusCode = response.status;
          res.setHeader('Content-Type', 'application/xml');
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(data);
        } catch (error: any) {
          console.error('[rss-proxy]', feedUrl, error.message);
          res.statusCode = error.name === 'AbortError' ? 504 : 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: error.name === 'AbortError' ? 'Feed timeout' : 'Failed to fetch feed' }));
        }
      });
    },
  };
}

function youtubeLivePlugin(): Plugin {
  return {
    name: 'youtube-live',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/youtube/live')) {
          return next();
        }

        const url = new URL(req.url, 'http://localhost');
        const channel = url.searchParams.get('channel');

        if (!channel) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing channel parameter' }));
          return;
        }

        try {
          const channelHandle = channel.startsWith('@') ? channel : `@${channel}`;
          const liveUrl = `https://www.youtube.com/${channelHandle}/live`;

          const ytRes = await fetch(liveUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            redirect: 'follow',
          });

          if (!ytRes.ok) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'public, max-age=300');
            res.end(JSON.stringify({ videoId: null, channel }));
            return;
          }

          const html = await ytRes.text();

          // Scope both fields to the same videoDetails block so we don't
          // combine a videoId from one object with isLive from another.
          let videoId: string | null = null;
          const detailsIdx = html.indexOf('"videoDetails"');
          if (detailsIdx !== -1) {
            const block = html.substring(detailsIdx, detailsIdx + 5000);
            const vidMatch = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
            const liveMatch = block.match(/"isLive"\s*:\s*true/);
            if (vidMatch && liveMatch) {
              videoId = vidMatch[1];
            }
          }

          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.end(JSON.stringify({ videoId, isLive: videoId !== null, channel }));
        } catch (error) {
          console.error(`[YouTube Live] Error:`, error);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Failed to fetch', videoId: null }));
        }
      });
    },
  };
}

function gpsjamDevPlugin(): Plugin {
  return {
    name: 'gpsjam-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/api/gpsjam' && !req.url?.startsWith('/api/gpsjam?')) {
          return next();
        }

        try {
          const data = await readFile(resolve(__dirname, 'scripts/data/gpsjam-latest.json'), 'utf8');
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(data);
        } catch {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(JSON.stringify({ error: 'No GPS jam data. Run: node scripts/fetch-gpsjam.mjs' }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Inject environment variables from .env files into process.env.
  // This ensures that API keys and other secrets in .env.local are
  // available to the dev server plugins and server-side handlers.
  Object.assign(process.env, env);

  const isE2E = process.env.VITE_E2E === '1';
  const isDesktopBuild = process.env.VITE_DESKTOP_RUNTIME === '1';
  const activeVariant = process.env.VITE_VARIANT || 'full';
  const activeMeta = VARIANT_META[activeVariant] || VARIANT_META.full;

  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      // Vercel sets VERCEL_GIT_COMMIT_SHA on production + preview builds.
      // Local `vite build` falls back to 'dev' — installStaleBundleCheck
      // detects the marker and skips the comparison so dev tabs don't
      // reload on every focus.
      __BUILD_HASH__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev'),
    },
    plugins: [
      // Emit dist/build-hash.txt with the deployed SHA so the running bundle
      // can fetch /build-hash.txt at tab-focus time and force-reload itself
      // if it's running an older bundle (see src/bootstrap/stale-bundle-check.ts).
      // Same-origin static asset, NOT under /api/* — installWebApiRedirect
      // doesn't touch it, so the comparison reflects the web deployment.
      {
        name: 'wm-emit-build-hash',
        apply: 'build',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'build-hash.txt',
            source: process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev',
          });
        },
      },
      htmlVariantPlugin(activeMeta, activeVariant, isDesktopBuild),
      aaiiBootstrapPlugin(),
      widgetAgentPlugin(),
      goatLivePlugin(),
      onDemandInsightsPlugin(),
      polymarketPlugin(),
      rssProxyPlugin(),
      youtubeLivePlugin(),
      gpsjamDevPlugin(),
      sebufApiPlugin(),
      brotliPrecompressPlugin(),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: false,

        includeAssets: [
          'favico/favicon.ico',
          'favico/apple-touch-icon.png',
          'favico/favicon-32x32.png',
        ],

        manifest: {
          name: `${activeMeta.siteName} - ${activeMeta.subject}`,
          short_name: activeMeta.shortName,
          description: activeMeta.description,
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'any',
          theme_color: '#0a0f0a',
          background_color: '#0a0f0a',
          categories: activeMeta.categories,
          icons: [
            { src: '/favico/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: '/favico/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
            { src: '/favico/android-chrome-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },

        workbox: {
          globPatterns: ['**/*.{js,css,ico,png,svg,woff2}'],
          globIgnores: ['**/ml*.js', '**/onnx*.wasm', '**/locale-*.js'],
          // globe.gl + three.js grows main bundle past the 2 MiB default limit
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          navigateFallback: null,
          skipWaiting: true,
          clientsClaim: true,
          cleanupOutdatedCaches: true,
          // Web Push handler (Phase 6). importScripts runs in the SW
          // context; /push-handler.js is a static file copied from
          // public/ and attaches 'push' + 'notificationclick' listeners.
          importScripts: ['/push-handler.js'],

          runtimeCaching: [
            {
              urlPattern: ({ request }: { request: Request }) => request.mode === 'navigate',
              handler: 'NetworkFirst',
              options: {
                cacheName: 'html-navigation',
                networkTimeoutSeconds: 5,
                cacheableResponse: { statuses: [200] },
              },
            },
            {
              urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
                sameOrigin && /^\/api\//.test(url.pathname),
              handler: 'NetworkOnly',
              method: 'GET',
            },
            {
              urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
                sameOrigin && /^\/api\//.test(url.pathname),
              handler: 'NetworkOnly',
              method: 'POST',
            },
            {
              urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
                sameOrigin && /^\/rss\//.test(url.pathname),
              handler: 'NetworkOnly',
              method: 'GET',
            },
            {
              urlPattern: ({ url }: { url: URL }) =>
                url.pathname.endsWith('.pmtiles') ||
                url.hostname.endsWith('.r2.dev') ||
                url.hostname === 'build.protomaps.com',
              handler: 'NetworkFirst',
              options: {
                cacheName: 'pmtiles-ranges',
                expiration: { maxEntries: 500, maxAgeSeconds: 30 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /^https:\/\/protomaps\.github\.io\//,
              handler: 'CacheFirst',
              options: {
                cacheName: 'protomaps-assets',
                expiration: { maxEntries: 100, maxAgeSeconds: 365 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'google-fonts-css',
                expiration: { maxEntries: 10, maxAgeSeconds: 365 * 24 * 60 * 60 },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-woff',
                expiration: { maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /\/assets\/locale-.*\.js$/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'locale-files',
                expiration: { maxEntries: 20, maxAgeSeconds: 30 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/i,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'images',
                expiration: { maxEntries: 100, maxAgeSeconds: 7 * 24 * 60 * 60 },
              },
            },
          ],
        },

        devOptions: {
          enabled: false,
        },
      }),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        child_process: resolve(__dirname, 'src/shims/child-process.ts'),
        'node:child_process': resolve(__dirname, 'src/shims/child-process.ts'),
        '@loaders.gl/worker-utils/dist/lib/process-utils/child-process-proxy.js': resolve(
          __dirname,
          'src/shims/child-process-proxy.ts'
        ),
      },
    },
    worker: {
      format: 'es',
    },
    build: {
      // Geospatial bundles (maplibre/deck) are expected to be large even when split.
      // Raise warning threshold to reduce noisy false alarms in CI.
      chunkSizeWarningLimit: 1200,
      // Vite 6 hoists every dynamic chunk's STATIC deps into the entry HTML's
      // modulepreload list to avoid latency on the first dynamic import. For the
      // map stack that defeats the whole point of dynamic-importing MapContainer:
      // ~3MB of WebGL deps would still download at parse time. Strip them here so
      // they only load when MapContainer's `await import(...)` actually fires
      // (still preloaded in parallel via __vitePreload at that moment).
      modulePreload: {
        resolveDependencies: (_filename, deps, { hostType }) => {
          if (hostType !== 'html') return deps;
          return deps.filter(d => !LAZY_HTML_PRELOAD_RE.test(d));
        },
      },
      rollupOptions: {
        onwarn(warning, warn) {
          // onnxruntime-web ships a minified browser bundle that intentionally uses eval.
          // Keep build logs focused by filtering this known third-party warning only.
          if (
            warning.code === 'EVAL'
            && typeof warning.id === 'string'
            && warning.id.includes('/onnxruntime-web/dist/ort-web.min.js')
          ) {
            return;
          }

          warn(warning);
        },
        input: {
          main: resolve(__dirname, 'index.html'),
          settings: resolve(__dirname, 'settings.html'),
          liveChannels: resolve(__dirname, 'live-channels.html'),
          mcpGrant: resolve(__dirname, 'mcp-grant.html'),
        },
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('/@xenova/transformers/')) {
                return 'transformers';
              }
              if (id.includes('/onnxruntime-web/')) {
                return 'onnxruntime';
              }
              // NOTE: chunk names below MUST match entries in LAZY_HTML_PRELOAD_CHUNKS
              // (top of file). The resolveDependencies filter relies on this string
              // identity; renaming here without updating the constant silently
              // re-eagerises the WebGL stack into the entry HTML's modulepreload list.
              if (id.includes('/maplibre-gl/') || id.includes('/pmtiles/') || id.includes('/@protomaps/basemaps/')) {
                return 'maplibre';
              }
              if (
                id.includes('/@deck.gl/')
                || id.includes('/@luma.gl/')
                || id.includes('/@loaders.gl/')
                || id.includes('/@math.gl/')
                || id.includes('/h3-js/')
              ) {
                return 'deck-stack';
              }
              if (id.includes('/d3/')) {
                return 'd3';
              }
              if (id.includes('/topojson-client/')) {
                return 'topojson';
              }
              if (id.includes('/i18next')) {
                return 'i18n';
              }
              if (id.includes('/@sentry/')) {
                return 'sentry';
              }
            }
            if (id.includes('/src/components/') && id.endsWith('Panel.ts')) {
              // Cluster split (PANEL_CLUSTER) is staged but disabled: it exposes
              // a systemic TDZ in panels with top-level `new XxxServiceClient(...)`
              // singletons (~20+ panels). They each need lazy-init refactors
              // before the cluster split can ship. See ce-doc-review followup.
              return 'panels';
            }
            // Give lazy-loaded locale chunks a recognizable prefix so the
            // service worker can exclude them from precache (en.json is
            // statically imported into the main bundle).
            const localeMatch = id.match(/\/locales\/(\w+)\.json$/);
            if (localeMatch && localeMatch[1] !== 'en') {
              return `locale-${localeMatch[1]}`;
            }
            return undefined;
          },
        },
      },
    },
    server: {
      port: 3001,
      strictPort: false,
      host: 'localhost',
      open: !isE2E,
      hmr: isE2E ? false : undefined,
      watch: {
        ignored: [
          '**/test-results/**',
          '**/playwright-report/**',
          '**/.playwright-mcp/**',
        ],
      },
      proxy: {
        // AlsaGlobal: widget-agent SSE proxy removed (upstream relay not operated by us).
        // Yahoo Finance API
        '/api/yahoo': {
          target: 'https://query1.finance.yahoo.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
        },
        // Polymarket handled by polymarketPlugin() — no prod proxy needed
        // USGS Earthquake API
        '/api/earthquake': {
          target: 'https://earthquake.usgs.gov',
          changeOrigin: true,
          timeout: 30000,
          rewrite: (path) => path.replace(/^\/api\/earthquake/, ''),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('Earthquake proxy error:', err.message);
            });
          },
        },
        // PizzINT - Pentagon Pizza Index
        '/api/pizzint': {
          target: 'https://www.pizzint.watch',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/pizzint/, '/api'),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('PizzINT proxy error:', err.message);
            });
          },
        },
        // FRED Economic Data - handled by Vercel serverless function in prod
        // In dev, we proxy to the API directly with the key from .env
        '/api/fred-data': {
          target: 'https://api.stlouisfed.org',
          changeOrigin: true,
          rewrite: (path) => {
            const url = new URL(path, 'http://localhost');
            const seriesId = url.searchParams.get('series_id');
            const start = url.searchParams.get('observation_start');
            const end = url.searchParams.get('observation_end');
            const apiKey = process.env.FRED_API_KEY || '';
            return `/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=10${start ? `&observation_start=${start}` : ''}${end ? `&observation_end=${end}` : ''}`;
          },
        },
        // RSS Feeds - BBC
        '/rss/bbc': {
          target: 'https://feeds.bbci.co.uk',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/bbc/, ''),
        },
        // RSS Feeds - Guardian
        '/rss/guardian': {
          target: 'https://www.theguardian.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/guardian/, ''),
        },
        // RSS Feeds - NPR
        '/rss/npr': {
          target: 'https://feeds.npr.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/npr/, ''),
        },
        // RSS Feeds - Al Jazeera
        '/rss/aljazeera': {
          target: 'https://www.aljazeera.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/aljazeera/, ''),
        },
        // RSS Feeds - CNN
        '/rss/cnn': {
          target: 'http://rss.cnn.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/cnn/, ''),
        },
        // RSS Feeds - Hacker News
        '/rss/hn': {
          target: 'https://hnrss.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/hn/, ''),
        },
        // RSS Feeds - Ars Technica
        '/rss/arstechnica': {
          target: 'https://feeds.arstechnica.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/arstechnica/, ''),
        },
        // RSS Feeds - The Verge
        '/rss/verge': {
          target: 'https://www.theverge.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/verge/, ''),
        },
        // RSS Feeds - CNBC
        '/rss/cnbc': {
          target: 'https://www.cnbc.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/cnbc/, ''),
        },
        // RSS Feeds - MarketWatch
        '/rss/marketwatch': {
          target: 'https://feeds.marketwatch.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/marketwatch/, ''),
        },
        // RSS Feeds - Defense/Intel sources
        '/rss/defenseone': {
          target: 'https://www.defenseone.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/defenseone/, ''),
        },
        '/rss/warontherocks': {
          target: 'https://warontherocks.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/warontherocks/, ''),
        },
        '/rss/breakingdefense': {
          target: 'https://breakingdefense.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/breakingdefense/, ''),
        },
        '/rss/bellingcat': {
          target: 'https://www.bellingcat.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/bellingcat/, ''),
        },
        // RSS Feeds - TechCrunch (layoffs)
        '/rss/techcrunch': {
          target: 'https://techcrunch.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/techcrunch/, ''),
        },
        // Google News RSS
        '/rss/googlenews': {
          target: 'https://news.google.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/googlenews/, ''),
        },
        // AI Company Blogs
        '/rss/openai': {
          target: 'https://openai.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/openai/, ''),
        },
        '/rss/anthropic': {
          target: 'https://www.anthropic.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/anthropic/, ''),
        },
        '/rss/googleai': {
          target: 'https://blog.google',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/googleai/, ''),
        },
        '/rss/deepmind': {
          target: 'https://deepmind.google',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/deepmind/, ''),
        },
        '/rss/huggingface': {
          target: 'https://huggingface.co',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/huggingface/, ''),
        },
        '/rss/techreview': {
          target: 'https://www.technologyreview.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/techreview/, ''),
        },
        '/rss/arxiv': {
          target: 'https://rss.arxiv.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/arxiv/, ''),
        },
        // Government
        '/rss/whitehouse': {
          target: 'https://www.whitehouse.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/whitehouse/, ''),
        },
        '/rss/statedept': {
          target: 'https://www.state.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/statedept/, ''),
        },
        '/rss/state': {
          target: 'https://www.state.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/state/, ''),
        },
        '/rss/defense': {
          target: 'https://www.defense.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/defense/, ''),
        },
        '/rss/justice': {
          target: 'https://www.justice.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/justice/, ''),
        },
        '/rss/cdc': {
          target: 'https://tools.cdc.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/cdc/, ''),
        },
        '/rss/fema': {
          target: 'https://www.fema.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/fema/, ''),
        },
        '/rss/dhs': {
          target: 'https://www.dhs.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/dhs/, ''),
        },
        '/rss/fedreserve': {
          target: 'https://www.federalreserve.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/fedreserve/, ''),
        },
        '/rss/sec': {
          target: 'https://www.sec.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/sec/, ''),
        },
        '/rss/treasury': {
          target: 'https://home.treasury.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/treasury/, ''),
        },
        '/rss/cisa': {
          target: 'https://www.cisa.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/cisa/, ''),
        },
        // Think Tanks
        '/rss/brookings': {
          target: 'https://www.brookings.edu',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/brookings/, ''),
        },
        '/rss/cfr': {
          target: 'https://www.cfr.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/cfr/, ''),
        },
        '/rss/csis': {
          target: 'https://www.csis.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/csis/, ''),
        },
        // Defense
        '/rss/warzone': {
          target: 'https://www.thedrive.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/warzone/, ''),
        },
        '/rss/defensegov': {
          target: 'https://www.defense.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/defensegov/, ''),
        },
        // Security
        '/rss/krebs': {
          target: 'https://krebsonsecurity.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/krebs/, ''),
        },
        // Finance
        '/rss/yahoonews': {
          target: 'https://finance.yahoo.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/yahoonews/, ''),
        },
        // Diplomat
        '/rss/diplomat': {
          target: 'https://thediplomat.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/diplomat/, ''),
        },
        // VentureBeat
        '/rss/venturebeat': {
          target: 'https://venturebeat.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/venturebeat/, ''),
        },
        // Foreign Policy
        '/rss/foreignpolicy': {
          target: 'https://foreignpolicy.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/foreignpolicy/, ''),
        },
        // Financial Times
        '/rss/ft': {
          target: 'https://www.ft.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/ft/, ''),
        },
        // Reuters
        '/rss/reuters': {
          target: 'https://www.reutersagency.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/reuters/, ''),
        },
        // Cloudflare Radar - Internet outages
        '/api/cloudflare-radar': {
          target: 'https://api.cloudflare.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/cloudflare-radar/, ''),
        },
        // NGA Maritime Safety Information - Navigation Warnings
        '/api/nga-msi': {
          target: 'https://msi.nga.mil',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/nga-msi/, ''),
        },
        // GDELT GEO 2.0 API - Global event data
        '/api/gdelt': {
          target: 'https://api.gdeltproject.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/gdelt/, ''),
        },
        // AISStream WebSocket proxy for live vessel tracking
        '/ws/aisstream': {
          target: 'wss://stream.aisstream.io',
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/ws\/aisstream/, ''),
        },
        // FAA NASSTATUS - Airport delays and closures
        '/api/faa': {
          target: 'https://nasstatus.faa.gov',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/faa/, ''),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('FAA NASSTATUS proxy error:', err.message);
            });
          },
        },
        // OpenSky Network - Aircraft tracking (military flight detection)
        '/api/opensky': {
          target: 'https://opensky-network.org/api',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/opensky/, ''),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('OpenSky proxy error:', err.message);
            });
          },
        },
        // ADS-B Exchange - Military aircraft tracking (backup/supplement)
        '/api/adsb-exchange': {
          target: 'https://adsbexchange.com/api',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/adsb-exchange/, ''),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('ADS-B Exchange proxy error:', err.message);
            });
          },
        },
      },
    },
  };
});
