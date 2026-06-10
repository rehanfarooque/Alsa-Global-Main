/**
 * AgentTools — function-call schema + dispatcher for ARGUS.
 *
 * ARGUS discovers all dashboard panels at runtime via ALL_PANELS, so it can
 * open ANY of the ~150 panels available across variants (full, tech, finance,
 * commodity, energy, happy). It can open many at once, zoom them, close them,
 * close every panel, lay out a grid, switch themes, and more.
 *
 * Tools:
 *   Discovery:   listPanels, findPanel
 *   Layout:      openPanel, openPanels, closePanel, closeAllPanels, zoomPanel,
 *                resizePanel, layoutGrid
 *   Data:        getMarketPrice, searchNews, getDailyBrief, getMacroSignals,
 *                openCountryBrief
 *   Creation:    buildWidget
 *   System:      setMapLayer, switchTheme
 *
 * All implementations are JSON-serializable. Side effects use CustomEvents
 * dispatched on `document`, with a single `wm:goat-action` listener in
 * panel-layout.ts that mediates panel scroll/highlight/zoom behavior.
 */

import type { AppContext } from '@/app/app-context';
import { openArgusPanel, closeAllArgusPanels, maximizeArgusPanel, restoreArgusPanel, updateArgusPanel } from './ArgusPanel';

/**
 * Client-side fetch with a hard timeout. The whole point is that ARGUS never
 * waits longer than ~4.5s for the backend, even when Yahoo is throttled and
 * the server cascade is grinding through 5 fallback sources. If we time out,
 * the panel already opened with a loading skeleton — the user sees something
 * fast and the panel either fills in once data lands, or stays loading.
 */
const CLIENT_FETCH_TIMEOUT_MS = 4500;

async function fetchJsonWithTimeout<T = unknown>(
  url: string,
  timeoutMs: number = CLIENT_FETCH_TIMEOUT_MS,
): Promise<T | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return null;
    return await resp.json() as T;
  } catch {
    return null;
  }
}

/**
 * Ask the GOAT overlay to dock as a chat window so the user can see the
 * dashboard react. Fired whenever a tool affects the dashboard underneath
 * (map move, real dashboard panel flash, etc.). The overlay listens for
 * this and toggles chat-mode on if it isn't already on.
 */
function requestChatMode(): void {
  try { document.dispatchEvent(new CustomEvent('argus:request-chat-mode')); } catch { /* SSR */ }
}
import { ALL_PANELS } from '@/config/panels';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, ToolParam>;
    required?: string[];
  };
}

interface ToolParam {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
}

export interface AgentToolsHandle {
  schema: ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export function createAgentTools(ctx: AppContext): AgentToolsHandle {
  const schema: ToolDefinition[] = [
    // ── DISCOVERY ───────────────────────────────────────────────────────────
    {
      name: 'listPanels',
      description: 'Returns the full catalog of available dashboard panels with their IDs and human names. Call this when you need to know what panels exist before opening or closing them.',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Optional keyword filter to narrow results (e.g. "market", "news", "intelligence")' },
        },
      },
    },
    {
      name: 'findPanel',
      description: 'Fuzzy-searches the panel catalog by name or topic and returns the best matching panel ID. Use this when the user names a panel loosely (e.g. "the markets one", "show me crypto stuff").',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (panel name, topic, or partial match)' },
        },
        required: ['query'],
      },
    },

    // ── LAYOUT ──────────────────────────────────────────────────────────────
    {
      name: 'openPanel',
      description: 'Opens a single panel by ID — scrolls it into view and highlights it. Use listPanels first if you do not know the exact ID.',
      parameters: {
        type: 'object',
        properties: {
          panelId: { type: 'string', description: 'The exact panel ID (kebab-case)' },
        },
        required: ['panelId'],
      },
    },
    {
      name: 'openPanels',
      description: 'Opens multiple panels at once (up to 100). Use this when the user wants to see several related panels together, or asks for "all market panels", "everything about Russia", etc. Pass an array of panel IDs.',
      parameters: {
        type: 'object',
        properties: {
          panelIds: { type: 'array', description: 'Array of panel IDs', items: { type: 'string' } },
        },
        required: ['panelIds'],
      },
    },
    {
      name: 'closePanel',
      description: 'Closes a single panel by ID.',
      parameters: {
        type: 'object',
        properties: {
          panelId: { type: 'string', description: 'The exact panel ID' },
        },
        required: ['panelId'],
      },
    },
    {
      name: 'closeAllPanels',
      description: 'Closes ONLY the floating widgets ARGUS has spawned (MARKET QUOTE, NEWS, CHART, WATCHLIST, HEATMAP, etc.). Does NOT touch the user\'s actual dashboard panels — those are the user\'s workspace and stay where they are. Use when the user says "close everything", "clear the widgets", "tidy up", "close all panels", or asks for a reset. If the user wants a SPECIFIC dashboard panel closed, call closePanel(panelId) with that one panel.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'zoomPanel',
      description: 'Opens a panel in fullscreen zoom overlay so the user can see it in detail. Use when the user says "zoom in", "expand", "maximize", "show me bigger".',
      parameters: {
        type: 'object',
        properties: {
          panelId: { type: 'string', description: 'The exact panel ID' },
        },
        required: ['panelId'],
      },
    },
    {
      name: 'resizePanel',
      description: 'Changes the row-span (height) of a panel. Span 1=normal, 2=tall, 3=very tall, 4=fullscreen.',
      parameters: {
        type: 'object',
        properties: {
          panelId: { type: 'string', description: 'The exact panel ID' },
          span: { type: 'number', description: 'Row span 1-4' },
        },
        required: ['panelId', 'span'],
      },
    },

    // ── DATA ────────────────────────────────────────────────────────────────
    {
      name: 'getMarketPrice',
      description: 'Live price and change for a stock, ETF, crypto, index, or futures. Examples: TSLA, AAPL, BTC-USD, ETH-USD, ^GSPC (S&P 500), ^IXIC (Nasdaq), ^VIX, GC=F (gold), CL=F (crude oil), EURUSD=X.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Yahoo-style ticker symbol' },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'searchNews',
      description: 'Search the live news feed for a topic. Returns top items with title, source, time.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords' },
          limit: { type: 'number', description: 'Max results (default 5, max 20)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'getDailyBrief',
      description: 'Returns today\'s curated intelligence brief.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'openCountryBrief',
      description: 'Opens the country-specific intelligence panel. Use ISO 3166-1 alpha-2 codes (US, RU, CN, IL, UA, IR, KP, IN, GB, FR, DE, JP, etc.).',
      parameters: {
        type: 'object',
        properties: {
          countryCode: { type: 'string', description: 'ISO alpha-2 country code' },
        },
        required: ['countryCode'],
      },
    },
    {
      name: 'getMacroSignals',
      description: 'Returns current macro market signals: liquidity, flow structure, regime, technical trend, momentum, fear/greed score.',
      parameters: { type: 'object', properties: {} },
    },

    // ── CREATION ────────────────────────────────────────────────────────────
    {
      name: 'buildWidget',
      description: 'Generates a custom interactive HTML widget from natural language and adds it to the dashboard. Examples: "compare BTC and gold over the last month", "top 10 most volatile stocks today", "OPEC oil production by country bar chart".',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Natural-language widget description' },
        },
        required: ['prompt'],
      },
    },

    {
      name: 'pointMapToCountry',
      description: 'Zooms the world map to a country. Use this when the user says "show me X on the map" or "where is X" or "zoom to X". Pass ISO 3166-1 alpha-2 codes (US, RU, UA, CN, IN, IL, IR, KP, GB, FR, DE, JP, BR, etc.). After zooming, this also pops a NEWS panel for that country.',
      parameters: {
        type: 'object',
        properties: {
          countryCode: { type: 'string', description: 'ISO alpha-2 country code' },
        },
        required: ['countryCode'],
      },
    },
    {
      name: 'analyzeConflict',
      description: 'POWER ORCHESTRATION TOOL — handles questions like "what is going on between X and Y" or "tell me about the situation in Z". Pass 1 to 4 ISO alpha-2 country codes plus optional keyword. The tool will: (1) toggle the map conflicts layer ON, (2) center the map on the involved region, (3) pull combined news for those countries / keyword, (4) pop ONE consolidated CONFLICT BRIEFING panel with relevant headlines, (5) try to spotlight any conflict / intelligence panel on the dashboard. Returns the assembled briefing so ARGUS can narrate a synthesis. Examples: analyzeConflict(["IR","IL"]) for Iran-Israel, analyzeConflict(["RU","UA"]) for Russia-Ukraine, analyzeConflict(["IN","PK"]) for India-Pakistan, analyzeConflict(["CN","TW"]) for China-Taiwan.',
      parameters: {
        type: 'object',
        properties: {
          countries: { type: 'array', items: { type: 'string' }, description: 'Two ISO alpha-2 country codes (e.g. ["IR","IL"])' },
          keywords:  { type: 'string', description: 'Optional extra search keywords (e.g. "ceasefire", "strikes")' },
        },
        required: ['countries'],
      },
    },
    {
      name: 'getCountryNews',
      description: 'Pulls the most recent news headlines for a country and pops them in a floating panel. Use this when the user asks "what is happening in X" or "news from X". Pass ISO 3166-1 alpha-2 codes.',
      parameters: {
        type: 'object',
        properties: {
          countryCode: { type: 'string', description: 'ISO alpha-2 country code' },
        },
        required: ['countryCode'],
      },
    },
    {
      name: 'showMarketOverview',
      description: 'Pops a live MARKET OVERVIEW panel showing major indices (S&P 500, Nasdaq, Dow), VIX, Bitcoin, Ethereum, gold, and oil. Use when the user says "show me the markets", "market overview", "how are markets doing", "what is going on in markets".',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'showCriticalNews',
      description: 'Pops a floating panel with the most recent critical world headlines from the news feed. Use when the user asks for "critical news", "breaking news", "headlines", "top stories", "what is happening".',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'describeVisiblePanels',
      description: 'Returns the list of dashboard panels CURRENTLY RENDERED on screen (not just configured) with each panel\'s id, name, visible status, and bounding position. Use BEFORE opening or pointing at a panel to make sure it exists. Also use when the user asks "what is on my screen", "what can I see", "what is open".',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'scanDashboard',
      description: 'POWER TOOL — returns every visible dashboard panel AND a short content snippet from each one in a single call. Use this as your FIRST action whenever the user asks an open-ended question like "what is going on", "give me a rundown", "summarize the world", "what is new", "anything important". You then pick the most relevant panels and either spotlight them OR narrate the most newsworthy item across all the snippets. Much faster than calling describeVisiblePanels + readPanel one by one.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'readPanel',
      description: 'Reads the visible text content of an existing dashboard panel so you can narrate what it shows. Use when the user asks "what does that panel say", "read that for me", "tell me what is in the markets panel". Returns first ~600 chars of the panel body.',
      parameters: {
        type: 'object',
        properties: { panelId: { type: 'string', description: 'Panel id from listPanels / describeVisiblePanels' } },
        required: ['panelId'],
      },
    },
    {
      name: 'spotlightPanel',
      description: 'Like openPanel but THEATRICAL — dims the whole rest of the dashboard, animates a glowing cyan border around the target, and points a directional arrow at it. Use for "show me X", "point to X", "where is X", "highlight the X panel". Spotlight auto-clears after 6 seconds.',
      parameters: {
        type: 'object',
        properties: { panelId: { type: 'string', description: 'Panel id to spotlight' } },
        required: ['panelId'],
      },
    },
    {
      name: 'showAsset',
      description: 'POWER TOOL — pops BOTH the live price panel AND the TradingView chart for any asset in one call. This is the DEFAULT tool for any "show me X", "I want to see X", "look up X", "let me see X" intent. Accepts loose terms (bitcoin, tesla, gold, S&P, EURUSD) and resolves them to the right symbol on both sides. Use this any time the user wants to LOOK at something — don\'t pick between price and chart, give them both.',
      parameters: {
        type: 'object',
        properties: {
          symbol:   { type: 'string', description: 'Loose name or ticker: "bitcoin" / "BTC" / "BTC-USD" / "Tesla" / "TSLA" / "gold" / "S&P" / "EURUSD" all work' },
          interval: { type: 'string', description: 'Chart bar interval: 1, 5, 15, 60 (default), 240, D, W, M', enum: ['1','5','15','60','240','D','W','M'] },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'openChart',
      description: 'Opens a LIVE TradingView candlestick chart for any symbol. Use whenever the user asks to "see the chart", "show me X chart", "open Bitcoin chart", "tradingview", "candlestick", "open a chart of …". Symbol should be TradingView form (EXCHANGE:TICKER) — for cryptocurrencies use BINANCE:BTCUSDT / BINANCE:ETHUSDT / BINANCE:SOLUSDT, for US stocks use NASDAQ:AAPL / NASDAQ:NVDA / NYSE:JPM, for forex use FX:EURUSD / FX:USDJPY, for indices use SP:SPX / NASDAQ:IXIC / TVC:DJI / TVC:VIX, for commodities use TVC:GOLD / TVC:USOIL / TVC:SILVER. Optional interval: 1, 5, 15, 60 (1h, default), 240 (4h), D, W, M.',
      parameters: {
        type: 'object',
        properties: {
          symbol:   { type: 'string', description: 'TradingView symbol in EXCHANGE:TICKER form' },
          interval: { type: 'string', description: 'Bar interval', enum: ['1', '5', '15', '60', '240', 'D', 'W', 'M'] },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'openWatchlist',
      description: 'Pops a LIVE watchlist panel with multiple symbols, each with price + change + mini sparkline that refreshes every 6 seconds. Use when the user says "watch X, Y, Z", "track these", "build a watchlist", "show me X and Y together", or to monitor 2+ instruments at once.',
      parameters: {
        type: 'object',
        properties: {
          symbols: { type: 'array', items: { type: 'string' }, description: 'Array of Yahoo-style symbols (e.g. ["BTC-USD","ETH-USD","TSLA","NVDA"])' },
        },
        required: ['symbols'],
      },
    },
    {
      name: 'openSectorHeatmap',
      description: 'Pops a colour-graded heatmap of the 11 US sector ETFs (XLK Technology, XLF Financials, XLE Energy, XLV Healthcare, XLY Consumer Discretionary, XLP Consumer Staples, XLI Industrials, XLB Materials, XLU Utilities, XLRE Real Estate, XLC Communication). Use when the user asks "sector heatmap", "how are sectors doing", "sector performance", "what is leading the market".',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'showTopMovers',
      description: 'Scans ~25 major US stocks and pops a watchlist of the biggest gainers OR losers today. Use when the user asks "top movers", "biggest gainers", "biggest losers", "what is hot", "what is dumping".',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: '"up" for gainers, "down" for losers' },
          count: { type: 'number', description: 'How many to show (default 8)' },
        },
        required: ['direction'],
      },
    },
    {
      name: 'compareSymbols',
      description: 'Side-by-side live comparison of 2 to 8 symbols. Use when the user says "compare X vs Y", "side by side", "X against Y", or asks about two or more assets in one breath ("how do Nvidia and AMD look").',
      parameters: {
        type: 'object',
        properties: {
          symbols: { type: 'array', items: { type: 'string' }, description: 'Two or more Yahoo-style symbols' },
        },
        required: ['symbols'],
      },
    },
    {
      name: 'convertCurrency',
      description: 'Converts an amount from one currency or asset to another using live Yahoo rates. Use when the user says "convert 100 dollars to rupees", "how much is 1 bitcoin in INR", "100 USD in JPY", "10 ETH in EUR". Supports any combo of fiat (USD, EUR, GBP, JPY, INR, ...) and crypto (BTC, ETH, SOL, ...).',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'How many of the source currency/asset' },
          from: { type: 'string', description: 'Source ticker (USD, EUR, BTC, ETH, ...)' },
          to: { type: 'string', description: 'Target ticker (USD, EUR, INR, JPY, BTC, ...)' },
        },
        required: ['amount', 'from', 'to'],
      },
    },
    {
      name: 'maximizeLatestPanel',
      description: 'Expands the most recent floating panel to near-fullscreen so the user can see it big. Use when the user says "make it bigger", "full screen", "expand", "zoom in", "maximize that".',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'restoreLatestPanel',
      description: 'Collapses the maximized floating panel back to its normal floating size. Use when the user says "make it smaller", "minimize", "shrink", "restore".',
      parameters: { type: 'object', properties: {} },
    },

    // ── SYSTEM ──────────────────────────────────────────────────────────────
    {
      name: 'setMapLayer',
      description: 'Toggle a globe-map layer. Common IDs: conflicts, bases, pipelines, hotspots, ais (vessels), nuclear, fires, earthquakes, cyber.',
      parameters: {
        type: 'object',
        properties: {
          layerId: { type: 'string', description: 'Layer identifier' },
          enabled: { type: 'boolean', description: 'true to show, false to hide' },
        },
        required: ['layerId', 'enabled'],
      },
    },
    {
      name: 'switchTheme',
      description: 'Switch between dark and light UI theme.',
      parameters: {
        type: 'object',
        properties: {
          theme: { type: 'string', description: 'Theme name', enum: ['dark', 'light'] },
        },
        required: ['theme'],
      },
    },
  ];

  const execute = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      switch (name) {
        // Discovery
        case 'listPanels':       return listPanels(String(args.filter ?? ''));
        case 'findPanel':        return findPanel(String(args.query ?? ''));

        // Layout
        case 'openPanel':        return openPanel(String(args.panelId ?? ''), ctx);
        case 'openPanels':       return openPanels(toStringArray(args.panelIds), ctx);
        case 'closePanel':       return closePanel(String(args.panelId ?? ''));
        case 'closeAllPanels':   return closeAllPanels();
        case 'zoomPanel':        return zoomPanel(String(args.panelId ?? ''));
        case 'resizePanel':      return resizePanel(String(args.panelId ?? ''), Number(args.span ?? 2));

        // Data
        case 'getMarketPrice':   return getMarketPrice(String(args.symbol ?? ''));
        case 'searchNews':       return searchNews(ctx, String(args.query ?? ''), Number(args.limit ?? 5));
        case 'getDailyBrief':    return getDailyBrief(ctx);
        case 'openCountryBrief': return openCountryBrief(String(args.countryCode ?? ''));
        case 'getMacroSignals':  return getMacroSignals();

        // Creation
        case 'buildWidget':      return buildWidget(String(args.prompt ?? ''));

        // Map + country
        case 'pointMapToCountry':   return pointMapToCountry(String(args.countryCode ?? ''), ctx);
        case 'getCountryNews':      return getCountryNews(String(args.countryCode ?? ''), ctx);
        case 'analyzeConflict':     return analyzeConflict(toStringArray(args.countries), String(args.keywords ?? ''), ctx);
        case 'showMarketOverview':  return showMarketOverview();
        case 'showCriticalNews':    return showCriticalNews(ctx);
        case 'openChart':           return openChart(String(args.symbol ?? ''), String(args.interval ?? '60'));
        case 'showAsset':           return showAsset(String(args.symbol ?? ''), String(args.interval ?? '60'));
        case 'describeVisiblePanels': return describeVisiblePanels();
        case 'scanDashboard':        return scanDashboard();
        case 'readPanel':           return readPanel(String(args.panelId ?? ''));
        case 'spotlightPanel':      return spotlightPanel(String(args.panelId ?? ''));
        case 'openWatchlist':       return openWatchlist(toStringArray(args.symbols));
        case 'openSectorHeatmap':   return openSectorHeatmap();
        case 'showTopMovers':       return showTopMovers(String(args.direction ?? 'up'), Number(args.count ?? 8));
        case 'compareSymbols':      return compareSymbols(toStringArray(args.symbols));
        case 'convertCurrency':     return convertCurrency(Number(args.amount ?? 0), String(args.from ?? ''), String(args.to ?? ''));
        case 'maximizeLatestPanel': return { ok: maximizeArgusPanel() };
        case 'restoreLatestPanel':  return { ok: restoreArgusPanel() };

        // System
        case 'setMapLayer':      return setMapLayer(String(args.layerId ?? ''), Boolean(args.enabled));
        case 'switchTheme':      return switchTheme(String(args.theme ?? 'dark'));

        default:                 return { error: `Unknown tool: ${name}` };
      }
    } catch (err) {
      return { error: (err as Error).message };
    }
  };

  return { schema, execute };
}

// ─── DISCOVERY ──────────────────────────────────────────────────────────────

function listPanels(filter: string): { total: number; panels: Array<{ id: string; name: string }> } {
  const f = filter.toLowerCase().trim();
  const entries = Object.entries(ALL_PANELS)
    .map(([id, cfg]) => ({ id, name: cfg.name }))
    .filter(({ id, name }) => !f || id.includes(f) || name.toLowerCase().includes(f))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { total: entries.length, panels: entries };
}

function findPanel(query: string): { panelId: string | null; name: string | null; alternatives: Array<{ id: string; name: string }> } {
  if (!query) return { panelId: null, name: null, alternatives: [] };
  const q = query.toLowerCase().trim();
  const scored = Object.entries(ALL_PANELS).map(([id, cfg]) => {
    const name = cfg.name.toLowerCase();
    let score = 0;
    if (id === q) score = 1000;
    else if (name === q) score = 900;
    else if (id.includes(q)) score = 100 + (q.length / id.length) * 50;
    else if (name.includes(q)) score = 80 + (q.length / name.length) * 50;
    // Token overlap
    const qTokens = q.split(/\s+/);
    const nameTokens = name.split(/\s+/);
    for (const qt of qTokens) {
      if (qt.length < 3) continue;
      if (nameTokens.includes(qt)) score += 30;
      else if (nameTokens.some((nt) => nt.includes(qt))) score += 15;
    }
    return { id, name: cfg.name, score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { panelId: null, name: null, alternatives: [] };
  const top = scored[0]!;
  return {
    panelId: top.id,
    name: top.name,
    alternatives: scored.slice(1, 4).map((s) => ({ id: s.id, name: s.name })),
  };
}

// ─── LAYOUT ─────────────────────────────────────────────────────────────────

async function openPanel(panelId: string, ctx: AppContext): Promise<{ ok: boolean; panelId: string; message: string; source?: string }> {
  if (!panelId) return { ok: false, panelId, message: 'No panel ID given.' };

  // 1. Try direct match
  let el = document.querySelector<HTMLElement>(`[data-panel="${cssEscape(panelId)}"]`);

  // 2. Try fuzzy match
  if (!el) {
    const match = findPanel(panelId);
    if (match.panelId) {
      el = document.querySelector<HTMLElement>(`[data-panel="${cssEscape(match.panelId)}"]`);
      if (el) panelId = match.panelId;
    }
  }

  // 3. Dashboard panel found — flash it + show confirm card
  if (el) {
    const friendlyName = ALL_PANELS[panelId]?.name ?? panelId;
    // Auto-dock so the user sees the dashboard panel actually flash. Without
    // chat-mode the immersive overlay hides whatever ARGUS is highlighting.
    requestChatMode();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('goat-flash');
    setTimeout(() => el!.classList.remove('goat-flash'), 1500);
    openArgusPanel({
      kind: 'panel-confirm',
      title: 'PANEL OPENED',
      headline: friendlyName,
      subtitle: 'DASHBOARD',
      confirm: { panelId, name: friendlyName },
    });
    return { ok: true, panelId, message: `Opened "${friendlyName}".`, source: 'dashboard' };
  }

  // 4. SMART FALLBACK — no exact panel match, but ARGUS asked for something.
  //    Inspect the requested name and spawn a floating panel with real content
  //    based on whichever data domain the name implies. The user always gets
  //    something useful instead of "PANEL NOT LOADED".
  return openSmartFallback(panelId, ctx);
}

/**
 * Synthesize a floating panel from the requested panelId by inspecting which
 * data domain it implies, then pulling real data from whichever endpoint
 * matches. So `news-feed`, `intelligence-feed`, `market-overview`, `world-news`
 * all resolve to a meaningful panel rather than a "PANEL NOT LOADED" stub.
 */
async function openSmartFallback(panelId: string, ctx: AppContext): Promise<{ ok: boolean; panelId: string; message: string; source: string }> {
  const lower = panelId.toLowerCase();

  // ── News / headlines / feed ─────────────────────────────────────────────
  if (/news|headline|feed|stor(?:y|ies)|critical/.test(lower)) {
    const items = (ctx.allNews ?? []).slice(0, 12).map((n) => ({
      title: n.title ?? '',
      source: n.source,
      ts: n.pubDate instanceof Date ? n.pubDate.toISOString() : String(n.pubDate),
      location: n.locationName,
    }));
    openArgusPanel({
      kind: 'news',
      title: 'NEWS FEED',
      headline: 'LATEST',
      subtitle: `${items.length} STORIES · LIVE`,
      news: items,
    });
    return { ok: true, panelId, message: `Pulled the ${items.length} most-recent stories.`, source: 'news-fallback' };
  }

  // ── Market overview ─────────────────────────────────────────────────────
  if (/market|overview|stock|quote|price|index|indice/.test(lower)) {
    // Delegate to the canonical showMarketOverview which opens with skeleton
    // first and updates when data lands — same UX as if the model called it.
    void showMarketOverview();
    return { ok: true, panelId, message: 'Showing major markets.', source: 'market-fallback' };
  }

  // ── Intel / brief / insights ────────────────────────────────────────────
  if (/intel|brief|insight|analy|summary|daily|alert|signal/.test(lower)) {
    void getDailyBrief(ctx);
    return { ok: true, panelId, message: 'Showing the daily intelligence brief.', source: 'brief-fallback' };
  }

  // ── Macro signals ───────────────────────────────────────────────────────
  if (/macro|regime|liquidity|flow|momentum/.test(lower)) {
    try {
      const resp = await fetch('/api/economic/v1/get-macro-signals');
      if (resp.ok) {
        const data = await resp.json() as Record<string, unknown>;
        const kv = Object.entries(data)
          .filter(([_, v]) => typeof v === 'string' || typeof v === 'number')
          .slice(0, 10)
          .map(([label, value]) => ({ label, value: String(value) }));
        openArgusPanel({
          kind: 'kv',
          title: 'MACRO SIGNALS',
          headline: 'REGIME',
          subtitle: 'LIVE',
          kv,
        });
        return { ok: true, panelId, message: 'Showing live macro regime.', source: 'macro-fallback' };
      }
    } catch { /* fall through */ }
  }

  // ── Country / map / world ───────────────────────────────────────────────
  if (/country|countries|map|region|world|globe/.test(lower)) {
    openArgusPanel({
      kind: 'text',
      title: 'COUNTRY VIEW',
      headline: 'TELL ME WHICH',
      subtitle: 'ASK BY NAME',
      text: 'Tell me which country you want to look at — say "show me Russia" or "what about Ukraine" and I will zoom the map there and pull the latest stories.',
    });
    return { ok: true, panelId, message: 'Asked the user which country.', source: 'country-prompt' };
  }

  // ── Catch-all — at least show real content (latest news) instead of an error
  const fallbackItems = (ctx.allNews ?? []).slice(0, 10).map((n) => ({
    title: n.title ?? '',
    source: n.source,
    ts: n.pubDate instanceof Date ? n.pubDate.toISOString() : String(n.pubDate),
    location: n.locationName,
  }));
  openArgusPanel({
    kind: 'news',
    title: 'LATEST',
    headline: panelId.toUpperCase(),
    subtitle: `${fallbackItems.length} STORIES · DEFAULT VIEW`,
    news: fallbackItems,
  });
  return { ok: true, panelId, message: `No exact panel match. Showing latest news as a default view.`, source: 'generic-fallback' };
}

/** Return the set of [data-panel] elements currently in the DOM. */
function getRenderedPanels(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-panel]'));
}

/** True when at least 30% of an element's bounding rect intersects the viewport. */
function isElementVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
  const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  const visArea = visW * visH;
  return visArea / (r.width * r.height) > 0.3;
}

function describeVisiblePanels(): unknown {
  const all = getRenderedPanels();
  const panels = all.map((el) => {
    const id = el.dataset.panel ?? '';
    const cfg = ALL_PANELS[id];
    const r = el.getBoundingClientRect();
    return {
      id,
      name: cfg?.name ?? id,
      visible: isElementVisible(el),
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
  const visible = panels.filter((p) => p.visible);
  const total   = panels.length;
  return {
    total,
    visibleCount: visible.length,
    panels,
    summary: visible.length === 0
      ? `${total} panels rendered but none currently in the viewport.`
      : `${visible.length} of ${total} panels are in view: ${visible.slice(0, 8).map((p) => p.name).join(', ')}${visible.length > 8 ? '…' : ''}`,
  };
}

/**
 * Walk every visible panel and return id + name + a short text snippet, all
 * in one go. Lets ARGUS answer "what's going on" without a chatty multi-tool
 * round trip — she gets the whole picture and decides what to highlight.
 */
function scanDashboard(): unknown {
  const all = getRenderedPanels();
  const items = all
    .filter((el) => isElementVisible(el))
    .slice(0, 24)   // cap so the response stays compact for the LLM context
    .map((el) => {
      const id = el.dataset.panel ?? '';
      const cfg = ALL_PANELS[id];
      const text = (el.innerText ?? el.textContent ?? '').trim().replace(/\s+/g, ' ');
      return {
        id,
        name: cfg?.name ?? id,
        snippet: text.slice(0, 220),
        chars: text.length,
      };
    });
  return {
    visibleCount: items.length,
    summary: items.length === 0
      ? 'No panels are currently visible on the dashboard.'
      : `${items.length} panels visible. First headlines: ${items.slice(0, 4).map((i) => i.name).join(', ')}.`,
    panels: items,
  };
}

function readPanel(panelId: string): unknown {
  if (!panelId) return { error: 'No panel ID given' };
  let el = document.querySelector<HTMLElement>(`[data-panel="${cssEscape(panelId)}"]`);
  if (!el) {
    const match = findPanel(panelId);
    if (match.panelId) el = document.querySelector<HTMLElement>(`[data-panel="${cssEscape(match.panelId)}"]`);
  }
  if (!el) return { error: `Panel "${panelId}" not rendered` };
  // innerText respects visibility & gives readable text in DOM order
  const text = (el.innerText ?? el.textContent ?? '').trim().replace(/\s+/g, ' ');
  const name = ALL_PANELS[panelId]?.name ?? panelId;
  const snippet = text.slice(0, 600);
  return {
    panelId,
    name,
    chars: text.length,
    truncated: text.length > 600,
    content: snippet,
  };
}

/**
 * Spotlight a panel: dim the whole dashboard, glow the target, point an
 * animated arrow at it. Auto-clears after 6s or when the user opens
 * something else.
 */
function spotlightPanel(panelId: string): unknown {
  if (!panelId) return { error: 'No panel ID given' };
  let el = document.querySelector<HTMLElement>(`[data-panel="${cssEscape(panelId)}"]`);
  if (!el) {
    const match = findPanel(panelId);
    if (match.panelId) {
      el = document.querySelector<HTMLElement>(`[data-panel="${cssEscape(match.panelId)}"]`);
      if (el) panelId = match.panelId;
    }
  }
  if (!el) return { error: `Panel "${panelId}" not rendered. Use describeVisiblePanels first.` };

  requestChatMode();   // dock so user can see the dashboard
  clearSpotlight();    // tear down any prior spotlight before starting a new one

  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('goat-spotlight');
  document.body.classList.add('goat-spotlight-active');

  // Directional arrow pointing at the panel from the left edge
  const arrow = document.createElement('div');
  arrow.className = 'goat-spotlight-arrow';
  document.body.appendChild(arrow);
  positionSpotlightArrow(arrow, el);
  const onResize = () => positionSpotlightArrow(arrow, el!);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onResize, true);

  // Auto-clear after 6 s
  spotlightTimer = setTimeout(() => clearSpotlight(), 6000);
  spotlightCleanup = () => {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onResize, true);
    arrow.remove();
    el!.classList.remove('goat-spotlight');
    document.body.classList.remove('goat-spotlight-active');
  };
  return { ok: true, panelId, name: ALL_PANELS[panelId]?.name ?? panelId };
}

let spotlightTimer: ReturnType<typeof setTimeout> | null = null;
let spotlightCleanup: (() => void) | null = null;
function clearSpotlight(): void {
  if (spotlightTimer) { clearTimeout(spotlightTimer); spotlightTimer = null; }
  if (spotlightCleanup) { spotlightCleanup(); spotlightCleanup = null; }
}

function positionSpotlightArrow(arrow: HTMLElement, target: HTMLElement): void {
  const r = target.getBoundingClientRect();
  // Place arrow ~60px to the left of the panel, vertically centered.
  // If the panel is too far left, anchor to the right side instead.
  const preferLeft = r.left > 200;
  if (preferLeft) {
    arrow.style.left = `${Math.max(8, r.left - 78)}px`;
    arrow.style.top  = `${r.top + r.height / 2 - 24}px`;
    arrow.dataset.dir = 'right'; // arrow points right toward panel
  } else {
    arrow.style.left = `${Math.min(window.innerWidth - 60, r.right + 18)}px`;
    arrow.style.top  = `${r.top + r.height / 2 - 24}px`;
    arrow.dataset.dir = 'left';
  }
}

async function openPanels(panelIds: string[], ctx: AppContext): Promise<{ ok: boolean; opened: string[]; skipped: string[]; message: string }> {
  const ids = panelIds.slice(0, 100); // cap at 100 to honor user's "100 panels" target
  const opened: string[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const result = await openPanel(id, ctx);
    if (result.ok) opened.push(result.panelId);
    else skipped.push(id);
    // Tiny stagger so the highlights don't all stomp each other
    await new Promise((r) => setTimeout(r, 35));
  }
  return {
    ok: opened.length > 0,
    opened,
    skipped,
    message: `Opened ${opened.length} panel(s)${skipped.length > 0 ? `, skipped ${skipped.length}` : ''}.`,
  };
}

function closePanel(panelId: string): { ok: boolean; panelId: string } {
  const el = document.querySelector<HTMLElement>(`[data-panel="${cssEscape(panelId)}"]`);
  if (!el) return { ok: false, panelId };
  el.dispatchEvent(new CustomEvent('wm:panel-close', { bubbles: true, detail: { panelId } }));
  return { ok: true, panelId };
}

/**
 * Close all ARGUS-spawned widgets ONLY.
 *
 * IMPORTANT: this no longer touches the user's actual dashboard panels.
 * The user's dashboard is their workspace — running closeAll on every dashboard
 * panel because the user said "close everything" is destructive and was the
 * source of the major bug they reported. If ARGUS needs to close a *specific*
 * dashboard panel, the user can name it and she'll call closePanel(id).
 */
function closeAllPanels(): { ok: boolean; closed: number } {
  const closed = closeAllArgusPanels();
  return { ok: true, closed };
}

function zoomPanel(panelId: string): { ok: boolean; panelId: string; message: string } {
  const el = document.querySelector<HTMLElement>(`[data-panel="${cssEscape(panelId)}"]`);
  if (!el) return { ok: false, panelId, message: `Panel "${panelId}" not rendered.` };
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const expandBtn = el.querySelector<HTMLButtonElement>('.panel-expand-btn');
  if (expandBtn) {
    setTimeout(() => expandBtn.click(), 200);
    return { ok: true, panelId, message: `Zooming in on "${ALL_PANELS[panelId]?.name ?? panelId}".` };
  }
  return { ok: false, panelId, message: 'This panel does not support zoom.' };
}

function resizePanel(panelId: string, span: number): { ok: boolean; panelId: string; span: number } {
  const el = document.querySelector<HTMLElement>(`[data-panel="${cssEscape(panelId)}"]`);
  if (!el) return { ok: false, panelId, span };
  const s = Math.max(1, Math.min(4, Math.round(span)));
  el.classList.remove('span-1', 'span-2', 'span-3', 'span-4');
  if (s > 1) el.classList.add(`span-${s}`);
  el.classList.add('resized');
  return { ok: true, panelId, span: s };
}

// ─── DATA ───────────────────────────────────────────────────────────────────

async function getMarketPrice(symbol: string): Promise<unknown> {
  if (!symbol) return { error: 'No symbol given' };
  const sym = symbol.trim().toUpperCase();
  const isLiveTickerSymbol =
    /-USD$/i.test(sym) ||      // crypto
    /=X$/i.test(sym) ||         // forex
    /=F$/i.test(sym);           // futures

  // 1. Open the panel IMMEDIATELY with a loading skeleton. The user sees
  //    something within ~50ms instead of waiting for the cascade.
  const panelId = openArgusPanel({
    kind: 'quote',
    title: 'MARKET QUOTE',
    headline: sym,
    subtitle: 'FETCHING…',
    loading: true,
  });

  // 2. Fetch in the background with a hard client timeout.
  const data = await fetchJsonWithTimeout<{ quotes?: Array<{ symbol: string; price: number; change: number }> }>(
    `/api/market/v1/list-market-quotes?symbols=${encodeURIComponent(sym)}`,
  );
  const q = data?.quotes?.find((x) => x.symbol.toUpperCase() === sym) ?? data?.quotes?.[0];

  // 3a. No data even after timeout — keep the panel up but mark it stale so
  //     the user knows we tried. ARGUS narrates briefly without a number.
  if (!q) {
    updateArgusPanel(panelId, {
      kind: 'quote',
      subtitle: 'NO LIVE DATA',
      loading: false,
      quote: { symbol: sym, price: NaN, changePercent: 0 },
    });
    return { ok: false, symbol: sym, summary: `Couldn't pull a live ${sym} price just now.` };
  }

  // 3b. Got data — swap in real quote and enable live refresh for tickers.
  updateArgusPanel(panelId, {
    kind: 'quote',
    subtitle: isLiveTickerSymbol ? 'LIVE TICKER · YAHOO' : 'PRICE · YAHOO',
    loading: false,
    quote: { symbol: q.symbol, price: q.price, changePercent: q.change },
    liveRefreshMs: isLiveTickerSymbol ? 5000 : undefined,
  });
  return {
    symbol: q.symbol,
    price: q.price,
    changePercent: q.change,
    summary: `${q.symbol} is at ${q.price.toFixed(2)}, ${q.change >= 0 ? 'up' : 'down'} ${Math.abs(q.change).toFixed(2)}%.`,
  };
}

async function searchNews(ctx: AppContext, query: string, limit: number): Promise<unknown> {
  const q = query.toLowerCase().trim();
  const all = ctx.allNews ?? [];
  const localItems = q
    ? all.filter((n) => (n.title ?? '').toLowerCase().includes(q) || (n.locationName ?? '').toLowerCase().includes(q))
    : all;
  const cap = Math.max(1, Math.min(20, limit || 5));
  let mapped = localItems.slice(0, cap).map((n) => ({
    title: n.title ?? '',
    source: n.source,
    ts: n.pubDate instanceof Date ? n.pubDate.toISOString() : String(n.pubDate),
    url: n.link,
    location: n.locationName,
  }));

  // Fallback: if local cache doesn't have enough hits for a real query, fetch
  // fresh from Google News RSS so ARGUS has something to narrate.
  if (q && mapped.length < 3) {
    const fresh = await fetchCountryHeadlinesViaRss(query, cap);
    if (fresh.length > 0) {
      const seen = new Set(mapped.map((i) => i.title));
      for (const f of fresh) {
        if (!seen.has(f.title)) {
          mapped.push({ title: f.title, source: f.source, ts: f.ts, url: f.url, location: f.location });
          seen.add(f.title);
        }
      }
      mapped = mapped.slice(0, cap);
    }
  }

  openArgusPanel({
    kind: 'news',
    title: 'NEWS SEARCH',
    headline: query || 'LATEST',
    subtitle: `${mapped.length} HEADLINE${mapped.length === 1 ? '' : 'S'}`,
    news: mapped.map((m) => ({ title: m.title ?? '', source: m.source, ts: m.ts, location: m.location })),
  });
  return { count: mapped.length, items: mapped };
}

/**
 * Daily brief composed from local data: top recent news + macro signals.
 * The cloud `/api/intelligence/v1/get-daily-brief` endpoint isn't deployed
 * locally — we synthesize from what's already loaded so ARGUS has something
 * to actually narrate instead of a 404.
 */
async function getDailyBrief(ctx: AppContext): Promise<unknown> {
  // Most recent 8 news items, biased toward those with locations (more newsworthy)
  const all = ctx.allNews ?? [];
  const sorted = [...all]
    .filter((n) => !!n.title)
    .sort((a, b) => {
      const ta = a.pubDate instanceof Date ? a.pubDate.getTime() : 0;
      const tb = b.pubDate instanceof Date ? b.pubDate.getTime() : 0;
      return tb - ta;
    })
    .slice(0, 8);

  // Lightweight macro snapshot — best-effort, ignore failure
  let macroSummary: string | null = null;
  try {
    const resp = await fetch('/api/economic/v1/get-macro-signals');
    if (resp.ok) {
      const j = await resp.json() as { verdict?: string; summary?: string };
      macroSummary = j.verdict || j.summary || null;
    }
  } catch { /* ignore — brief still works without macro */ }

  const brief = {
    generatedAt: new Date().toISOString(),
    macroSummary,
    topHeadlines: sorted.map((n) => ({
      title: n.title ?? '',
      source: n.source,
      location: n.locationName,
      ts: n.pubDate instanceof Date ? n.pubDate.toISOString() : String(n.pubDate),
    })),
    count: sorted.length,
  };

  openArgusPanel({
    kind: 'brief',
    title: 'DAILY BRIEF',
    headline: 'INTELLIGENCE',
    subtitle: new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).toUpperCase(),
    brief: { macroSummary: brief.macroSummary, topHeadlines: brief.topHeadlines, count: brief.count },
  });

  return brief;
}

function openCountryBrief(code: string): { ok: boolean; code: string } {
  if (!code) return { ok: false, code };
  const cc = code.toUpperCase().slice(0, 2);
  document.dispatchEvent(new CustomEvent('wm:open-country-brief', { detail: { code: cc } }));
  return { ok: true, code: cc };
}

async function getMacroSignals(): Promise<unknown> {
  try {
    const resp = await fetch('/api/economic/v1/get-macro-signals');
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    return await resp.json();
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// ─── CREATION ───────────────────────────────────────────────────────────────

/**
 * Widget builder — fails QUIETLY. The result object only contains an `ok`
 * boolean and an internal `code` for ARGUS to branch on. No human-readable
 * error strings — they would otherwise be narrated aloud by the voice model.
 *
 * Return shapes:
 *   { ok: true, title }                 — widget was built and added
 *   { ok: false, code: 'no-prompt' }    — user didn't give us anything
 *   { ok: false, code: 'unavailable' }  — any failure (timeout, no credits,
 *                                          provider error, no html). All
 *                                          collapsed into one code so ARGUS
 *                                          can't accidentally narrate the
 *                                          technical reason.
 */
async function buildWidget(prompt: string): Promise<unknown> {
  if (!prompt) return { ok: false, code: 'no-prompt' };
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const resp = await fetch('/widget-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, mode: 'create', tier: 'pro' }),
      signal: ctrl.signal,
    });
    if (!resp.ok || !resp.body) {
      console.warn(`[buildWidget] HTTP ${resp.status} from /widget-agent`);
      return { ok: false, code: 'unavailable' };
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let title = 'Custom widget';
    let html = '';
    let upstreamError: string | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'html_complete') html = String(ev.html ?? '');
          if (ev.type === 'done') title = String(ev.title ?? title);
          if (ev.type === 'error') {
            upstreamError = String(ev.message || 'unknown');
            console.warn(`[buildWidget] upstream error: ${upstreamError}`);
          }
        } catch { /* skip */ }
      }
    }
    if (!html) {
      console.warn(`[buildWidget] no html generated${upstreamError ? ` (reason: ${upstreamError})` : ''}`);
      return { ok: false, code: 'unavailable' };
    }
    document.dispatchEvent(new CustomEvent('wm:goat-add-widget', { detail: { title, html, prompt } }));
    return { ok: true, title };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    console.warn(`[buildWidget] ${aborted ? 'timed out' : (err as Error).message}`);
    return { ok: false, code: 'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── MAP + COUNTRY ──────────────────────────────────────────────────────────

// Sensible centers for countries whose bbox crosses the antimeridian (avg
// gives lon=0, which is wrong). Hand-picked centers for the few cases.
const ANTIMERIDIAN_CENTERS: Record<string, [number, number]> = {
  US: [39.8, -98.6],
  RU: [61.5, 90],
  FJ: [-17.7, 178.0],
  KI: [1.8, -157.4],
};

// Country name from ISO-2 via the browser's built-in Intl.DisplayNames — no
// hardcoded table. Falls back to the code itself if unsupported (very old
// browsers) or if the code is unknown to ICU.
let _displayNames: Intl.DisplayNames | null = null;
function getDisplayNames(): Intl.DisplayNames | null {
  if (_displayNames) return _displayNames;
  try {
    _displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
    return _displayNames;
  } catch {
    return null;
  }
}
function countryName(cc: string): string {
  const dn = getDisplayNames();
  if (!dn) return cc;
  try { return dn.of(cc) ?? cc; } catch { return cc; }
}

async function pointMapToCountry(code: string, ctx: AppContext): Promise<unknown> {
  if (!code) return { error: 'No country code' };
  const cc = code.toUpperCase().slice(0, 2);

  // Pull bbox lazily so the JSON isn't bundled into the GOAT lazy chunk
  let bbox: [number, number, number, number] | null = null;
  let bboxSource = 'unknown';
  try {
    const mod = await import('../../../shared/country-bboxes.json');
    const bboxes = (mod as unknown as { default: Record<string, number[]> }).default;
    const raw = bboxes[cc];
    if (Array.isArray(raw) && raw.length >= 4) {
      bbox = [raw[0]!, raw[1]!, raw[2]!, raw[3]!];
      bboxSource = 'bbox-json';
    } else {
      console.warn(`[pointMapToCountry] no bbox for "${cc}" in country-bboxes.json (have ${Object.keys(bboxes).length} entries)`);
    }
  } catch (err) {
    console.warn(`[pointMapToCountry] could not load country-bboxes.json:`, (err as Error).message);
  }

  if (!bbox) {
    openArgusPanel({
      kind: 'text',
      title: 'COUNTRY NOT FOUND',
      headline: cc,
      subtitle: 'NO COORDINATES',
      text: `I don't have map coordinates for "${cc}". Use a 2-letter ISO code like US, RU, UA, CN, IN, IL.`,
    });
    return { error: 'Unknown country', code: cc };
  }
  console.log(`[pointMapToCountry] ${cc} (${countryName(cc)}) bbox source=${bboxSource}, raw=`, bbox);

  const [south, west, north, east] = bbox;
  let lat = (south + north) / 2;
  let lon = (west + east) / 2;

  // Antimeridian special-case (Russia stretches -180→180, naive average = 0)
  if (west <= -179.5 && east >= 179.5) {
    const c = ANTIMERIDIAN_CENTERS[cc];
    if (c) { lat = c[0]; lon = c[1]; }
  }

  const spanDeg = Math.max(north - south, east - west);
  const zoom = Math.max(2.0, Math.min(7.0, Math.log2(360 / Math.max(spanDeg, 1))));

  // Auto-dock so the user can SEE the map fly. Without this the overlay
  // covers the dashboard and the map move feels invisible.
  requestChatMode();

  // Drive the actual map directly via the AppContext-held MapContainer.
  // This is the authoritative path — it flies the camera, syncs the URL,
  // and re-renders any layers that depend on the visible viewport.
  if (ctx.map) {
    try {
      ctx.map.setCenter(lat, lon, zoom);
      console.log(`[pointMapToCountry] ${cc} → setCenter(${lat.toFixed(2)}, ${lon.toFixed(2)}, z=${zoom.toFixed(1)}) ✓`);
    } catch (err) {
      console.warn(`[pointMapToCountry] setCenter threw:`, (err as Error).message);
    }
  } else {
    console.warn(`[pointMapToCountry] ctx.map is null — map not initialized yet?`);
  }

  // Belt-and-braces: also sync the URL so the state is shareable, and fire
  // the event for any other listener that wants to react.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('lat', lat.toFixed(4));
    url.searchParams.set('lon', lon.toFixed(4));
    url.searchParams.set('zoom', zoom.toFixed(2));
    window.history.replaceState({}, '', url.toString());
  } catch { /* ignore */ }
  document.dispatchEvent(new CustomEvent('wm:zoom-to-country', {
    detail: { code: cc, lat, lon, zoom, name: countryName(cc) },
  }));

  // And pop a NEWS panel for that country so the user has something to read
  await getCountryNews(cc, ctx);

  return { ok: true, code: cc, name: countryName(cc), lat, lon, zoom };
}

/**
 * Fetch country-specific headlines from Google News RSS via the local
 * /api/rss-proxy. Works without API keys, returns fresh results from any IP,
 * and the proxy domain is already on the allowlist. Used as a fallback when
 * the in-memory news cache doesn't have enough country-specific items
 * (e.g. on a freshly-booted self-host where RSS feeds haven't filled in).
 */
async function fetchCountryHeadlinesViaRss(
  countryName: string,
  limit = 8,
): Promise<Array<{ title: string; source: string; ts: string; location: string; url: string }>> {
  try {
    const q = encodeURIComponent(countryName);
    const feed = encodeURIComponent(
      `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
    );
    const resp = await fetch(`/api/rss-proxy?url=${feed}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return [];
    const xml = await resp.text();
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const items = Array.from(doc.querySelectorAll('item')).slice(0, limit);
    return items.map((item) => {
      const title = item.querySelector('title')?.textContent?.trim() ?? '';
      // Google News title pattern: "Headline - Source Name"
      let cleanTitle = title;
      let source = 'Google News';
      const dashIdx = title.lastIndexOf(' - ');
      if (dashIdx > 0) {
        cleanTitle = title.slice(0, dashIdx).trim();
        source = title.slice(dashIdx + 3).trim() || source;
      }
      const link = item.querySelector('link')?.textContent?.trim() ?? '';
      const pub = item.querySelector('pubDate')?.textContent?.trim() ?? '';
      const ts = pub ? new Date(pub).toISOString() : new Date().toISOString();
      return { title: cleanTitle, source, ts, location: countryName, url: link };
    });
  } catch (err) {
    console.warn('[getCountryNews] Google News RSS fallback failed:', (err as Error).message);
    return [];
  }
}

async function getCountryNews(code: string, ctx: AppContext): Promise<unknown> {
  if (!code) return { error: 'No country code' };
  const cc = code.toUpperCase().slice(0, 2);
  const name = countryName(cc);
  const nameLc = name.toLowerCase();
  const all = ctx.allNews ?? [];

  let items = all.filter((n) => {
    const loc = (n.locationName ?? '').toLowerCase();
    const title = (n.title ?? '').toLowerCase();
    // Match either the country name in the location, or in the headline itself
    return loc.includes(nameLc) || title.includes(nameLc);
  }).slice(0, 12).map((n) => ({
    title: n.title ?? '',
    source: n.source,
    ts: n.pubDate instanceof Date ? n.pubDate.toISOString() : String(n.pubDate),
    location: n.locationName,
  }));

  // Fallback: if local cache has < 3 country-specific items, fetch fresh from
  // Google News RSS so ARGUS can actually answer "what's happening in Iran".
  if (items.length < 3) {
    const fresh = await fetchCountryHeadlinesViaRss(name, 10);
    if (fresh.length > 0) {
      const seen = new Set(items.map((i) => i.title));
      for (const f of fresh) {
        if (!seen.has(f.title)) {
          items.push({ title: f.title, source: f.source, ts: f.ts, location: f.location });
          seen.add(f.title);
        }
      }
      items = items.slice(0, 12);
    }
  }

  openArgusPanel({
    kind: 'news',
    title: `${cc} NEWS`,
    headline: name.toUpperCase(),
    subtitle: `${items.length} STOR${items.length === 1 ? 'Y' : 'IES'} · LIVE`,
    news: items,
  });

  // Also fire the existing country-brief event so the dashboard's country
  // brief panel (if enabled) opens alongside
  document.dispatchEvent(new CustomEvent('wm:open-country-brief', { detail: { code: cc } }));

  return { ok: true, code: cc, name, count: items.length };
}

/**
 * Multi-country conflict / regional-tension briefing. The "what's going on
 * between X and Y" workflow — does ALL the right things at once:
 *   1. Toggles the conflicts map layer ON
 *   2. Centers the map roughly between the two countries
 *   3. Filters cached news for stories touching either country
 *   4. Pops ONE consolidated CONFLICT BRIEFING panel
 *   5. Spotlights any conflict / intelligence panel that's already on screen
 *   6. Returns the assembled briefing so ARGUS can narrate a synthesis
 */
async function analyzeConflict(countries: string[], keywords: string, ctx: AppContext): Promise<unknown> {
  const codes = countries.map((c) => c.trim().toUpperCase().slice(0, 2)).filter(Boolean).slice(0, 4);
  if (codes.length === 0) return { error: 'No countries given' };

  const names = codes.map(countryName);
  const kw = (keywords || '').toLowerCase().trim();

  // 1. Turn on the conflicts map layer so the user sees activity hotspots
  document.dispatchEvent(new CustomEvent('wm:goat-set-layer', {
    detail: { layerId: 'conflicts', enabled: true },
  }));
  requestChatMode();

  // 2. Find map coords for each, average them so the map view shows the region
  let bboxes: Record<string, [number, number, number, number]> = {};
  try {
    const mod = await import('../../../shared/country-bboxes.json');
    const raw = (mod as unknown as { default: Record<string, number[]> }).default;
    for (const cc of codes) {
      const b = raw[cc];
      if (Array.isArray(b) && b.length >= 4) bboxes[cc] = [b[0]!, b[1]!, b[2]!, b[3]!];
    }
  } catch { /* ignore */ }
  let camLat = 0, camLon = 0, hits = 0;
  for (const cc of codes) {
    const b = bboxes[cc];
    if (!b) continue;
    const [s, w, n, e] = b;
    camLat += (s + n) / 2;
    camLon += (w + e) / 2;
    hits++;
  }
  if (hits > 0 && ctx.map) {
    camLat /= hits;
    camLon /= hits;
    try { ctx.map.setCenter(camLat, camLon, 3.5); } catch { /* defensive */ }
  }

  // 3. Filter the loaded news for stories touching ANY of the named countries,
  //    AND optionally matching the extra keywords. Score by how many of the
  //    named countries the story touches — multi-country mentions rank highest.
  const all = ctx.allNews ?? [];
  const nameLcs = names.map((n) => n.toLowerCase());
  const scored = all
    .map((n) => {
      const title = (n.title ?? '').toLowerCase();
      const loc = (n.locationName ?? '').toLowerCase();
      let score = 0;
      for (const nm of nameLcs) {
        if (title.includes(nm)) score += 2;
        if (loc.includes(nm)) score += 1;
      }
      if (kw && (title.includes(kw) || loc.includes(kw))) score += 1;
      return { n, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((s) => ({
      title: s.n.title ?? '',
      source: s.n.source,
      ts: s.n.pubDate instanceof Date ? s.n.pubDate.toISOString() : String(s.n.pubDate),
      location: s.n.locationName,
    }));

  // 4. Pop the consolidated briefing panel
  openArgusPanel({
    kind: 'news',
    title: 'CONFLICT BRIEFING',
    headline: names.join(' ↔ '),
    subtitle: `${scored.length} STORIES${kw ? ` · "${kw}"` : ''}`,
    news: scored,
  });

  // 5. Try to spotlight an existing conflict / intelligence panel on the dashboard
  const candidates = ['conflicts', 'conflict-tracker', 'live-news', 'intelligence', 'cyber-threats', 'unrest'];
  for (const cand of candidates) {
    const el = document.querySelector<HTMLElement>(`[data-panel="${cssEscape(cand)}"]`);
    if (el) {
      // Reuse the spotlight pipeline if available
      try { spotlightPanel(cand); } catch { /* ignore */ }
      break;
    }
  }

  return {
    ok: true,
    countries: codes,
    names,
    storyCount: scored.length,
    summary: `Briefing for ${names.join(' and ')}: ${scored.length} matching stor${scored.length === 1 ? 'y' : 'ies'} pulled, conflicts layer enabled, map centered on the region.`,
    topHeadlines: scored.slice(0, 4).map((s) => s.title),
  };
}

async function showMarketOverview(): Promise<unknown> {
  // Friendly labels so the panel reads as "S&P 500" instead of "^GSPC"
  const symbolMeta: Array<{ symbol: string; label: string }> = [
    { symbol: '^GSPC',   label: 'S&P 500' },
    { symbol: '^IXIC',   label: 'Nasdaq' },
    { symbol: '^DJI',    label: 'Dow Jones' },
    { symbol: '^VIX',    label: 'VIX' },
    { symbol: 'BTC-USD', label: 'Bitcoin' },
    { symbol: 'ETH-USD', label: 'Ethereum' },
    { symbol: 'GC=F',    label: 'Gold' },
    { symbol: 'CL=F',    label: 'Crude Oil' },
  ];
  const syms = symbolMeta.map((m) => m.symbol);

  // 1. Open immediately with loading skeleton.
  const panelId = openArgusPanel({
    kind: 'kv',
    title: 'MARKET OVERVIEW',
    headline: 'MAJOR MARKETS',
    subtitle: 'FETCHING…',
    loading: true,
  });

  // 2. Fetch with hard client timeout — backend cascade may take 10s+ when
  //    Yahoo's throttled. We give it 4.5s and update with whatever lands.
  const data = await fetchJsonWithTimeout<{ quotes?: Array<{ symbol: string; price: number; change: number }> }>(
    `/api/market/v1/list-market-quotes?symbols=${syms.join(',')}`,
  );
  const byKey = new Map<string, { price: number; change: number }>();
  for (const q of data?.quotes ?? []) byKey.set(q.symbol.toUpperCase(), { price: q.price, change: q.change });

  const kv = symbolMeta.map((m) => {
    const q = byKey.get(m.symbol.toUpperCase());
    if (!q) return { label: m.label, value: '—' };
    const arrow = q.change >= 0 ? '▲' : '▼';
    const sign = q.change >= 0 ? '+' : '';
    return {
      label: m.label,
      value: `${q.price.toFixed(2)}   ${arrow} ${sign}${q.change.toFixed(2)}%`,
    };
  });

  const fetched = symbolMeta.filter((m) => byKey.has(m.symbol.toUpperCase())).length;
  updateArgusPanel(panelId, {
    kind: 'kv',
    subtitle: fetched === 0
      ? 'NO LIVE DATA'
      : `LIVE · ${fetched}/${symbolMeta.length} REFRESHED`,
    loading: false,
    kv,
  });
  return { ok: fetched > 0, count: fetched, requested: symbolMeta.length, items: data?.quotes ?? [] };
}

function showCriticalNews(ctx: AppContext): unknown {
  const all = ctx.allNews ?? [];
  // Most recent 12, sorted by pubDate desc
  const sorted = [...all].sort((a, b) => {
    const ta = a.pubDate instanceof Date ? a.pubDate.getTime() : 0;
    const tb = b.pubDate instanceof Date ? b.pubDate.getTime() : 0;
    return tb - ta;
  }).slice(0, 12);

  const items = sorted.map((n) => ({
    title: n.title ?? '',
    source: n.source,
    ts: n.pubDate instanceof Date ? n.pubDate.toISOString() : String(n.pubDate),
    location: n.locationName,
  }));

  openArgusPanel({
    kind: 'news',
    title: 'CRITICAL NEWS',
    headline: 'BREAKING',
    subtitle: `${items.length} STORIES · LATEST`,
    news: items,
  });

  return { ok: true, count: items.length };
}

// ─── WATCHLIST / HEATMAP / MOVERS / CONVERT ─────────────────────────────────

const SECTOR_ETFS: Array<{ symbol: string; label: string; sub: string }> = [
  { symbol: 'XLK',  label: 'Technology',         sub: 'XLK' },
  { symbol: 'XLF',  label: 'Financials',         sub: 'XLF' },
  { symbol: 'XLE',  label: 'Energy',             sub: 'XLE' },
  { symbol: 'XLV',  label: 'Healthcare',         sub: 'XLV' },
  { symbol: 'XLY',  label: 'Consumer Disc.',     sub: 'XLY' },
  { symbol: 'XLP',  label: 'Consumer Staples',   sub: 'XLP' },
  { symbol: 'XLI',  label: 'Industrials',        sub: 'XLI' },
  { symbol: 'XLB',  label: 'Materials',          sub: 'XLB' },
  { symbol: 'XLU',  label: 'Utilities',          sub: 'XLU' },
  { symbol: 'XLRE', label: 'Real Estate',        sub: 'XLRE' },
  { symbol: 'XLC',  label: 'Communications',     sub: 'XLC' },
];

// Mover-scan universe — the broader S&P 100 plus the biggest-cap names from
// crypto, gold, oil, and major indices. Yahoo handles all of these. Driven
// by the shared/stocks.json list when available so adding a ticker to that
// file automatically widens the scan; falls back to this hardcoded floor.
const MOVERS_UNIVERSE_FALLBACK = [
  'AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','BRK-B','LLY','AVGO',
  'WMT','JPM','V','UNH','XOM','MA','HD','PG','JNJ','BAC',
  'COST','KO','MRK','ABBV','CVX','PEP','MCD','ORCL','NFLX','TMO',
  'CRM','ADBE','ACN','AMD','INTC','QCOM','TXN','CSCO','IBM','GS',
  'MS','WFC','C','BLK','SCHW','AXP','SPGI','CAT','BA','GE',
  'HON','UPS','UNP','LMT','RTX','DE','MMM','VZ','T','CMCSA',
  'DIS','CRM','PYPL','SHOP','UBER','LYFT','SQ','COIN','PLTR','SNOW',
];

let _moversUniverseCache: string[] | null = null;
async function getMoversUniverse(): Promise<string[]> {
  if (_moversUniverseCache) return _moversUniverseCache;
  try {
    const mod = await import('../../../shared/stocks.json');
    const cfg = (mod as unknown as { default: { symbols?: Array<{ symbol: string }> } }).default;
    const fromConfig = (cfg.symbols ?? [])
      .map((s) => (s.symbol ?? '').trim())
      .filter((s) => /^[A-Z][A-Z.-]{0,9}$/.test(s));  // plain stock tickers only
    const merged = Array.from(new Set([...MOVERS_UNIVERSE_FALLBACK, ...fromConfig]));
    _moversUniverseCache = merged;
    return merged;
  } catch {
    _moversUniverseCache = MOVERS_UNIVERSE_FALLBACK;
    return MOVERS_UNIVERSE_FALLBACK;
  }
}

/**
 * Map a loose user term (or Yahoo symbol) to a TradingView symbol when ARGUS
 * hands us something that isn't already EXCHANGE:TICKER form. This lets the
 * tool tolerate ARGUS or the user typing "BTC" or "Tesla" directly.
 */
function toTradingViewSymbol(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  if (s.includes(':')) return s.toUpperCase();       // already EXCHANGE:TICKER

  const upper = s.toUpperCase();

  // Yahoo crypto BTC-USD → BINANCE:BTCUSDT
  if (/^[A-Z0-9]+-USD$/.test(upper)) {
    return `BINANCE:${upper.replace('-USD', 'USDT')}`;
  }
  // Yahoo forex EURUSD=X → FX:EURUSD
  if (/^[A-Z]{6}=X$/.test(upper)) return `FX:${upper.replace('=X', '')}`;
  // Yahoo futures GC=F → TVC:GOLD-ish — best-effort map for common ones
  if (/^GC=F$/i.test(upper)) return 'TVC:GOLD';
  if (/^CL=F$/i.test(upper)) return 'TVC:USOIL';
  if (/^SI=F$/i.test(upper)) return 'TVC:SILVER';
  if (/^NG=F$/i.test(upper)) return 'TVC:NATURALGAS';
  // Yahoo indices ^GSPC → SP:SPX
  if (upper === '^GSPC') return 'SP:SPX';
  if (upper === '^IXIC') return 'NASDAQ:IXIC';
  if (upper === '^DJI')  return 'TVC:DJI';
  if (upper === '^VIX')  return 'TVC:VIX';
  if (upper === '^FTSE') return 'TVC:UKX';
  if (upper === '^N225') return 'TVC:NI225';

  // Crypto words / common abbreviations
  const c: Record<string, string> = {
    BITCOIN: 'BINANCE:BTCUSDT', BTC: 'BINANCE:BTCUSDT',
    ETHEREUM: 'BINANCE:ETHUSDT', ETH: 'BINANCE:ETHUSDT',
    SOLANA: 'BINANCE:SOLUSDT', SOL: 'BINANCE:SOLUSDT',
    DOGE: 'BINANCE:DOGEUSDT', DOGECOIN: 'BINANCE:DOGEUSDT',
    XRP: 'BINANCE:XRPUSDT',
    ADA: 'BINANCE:ADAUSDT', CARDANO: 'BINANCE:ADAUSDT',
    MATIC: 'BINANCE:MATICUSDT', POLYGON: 'BINANCE:MATICUSDT',
  };
  if (c[upper]) return c[upper];

  // Plain US stock ticker → assume NASDAQ (TradingView accepts and resolves)
  if (/^[A-Z][A-Z.-]{0,9}$/.test(upper)) return `NASDAQ:${upper}`;

  return upper;
}

/**
 * Resolve a loose user term (or any symbol) into BOTH:
 *  - the Yahoo-style ticker (for price + sparkline panel)
 *  - the TradingView "EXCHANGE:TICKER" form (for chart panel)
 *
 * Examples
 *   "bitcoin"   → { yahoo: 'BTC-USD',  tv: 'BINANCE:BTCUSDT' }
 *   "tesla"     → { yahoo: 'TSLA',     tv: 'NASDAQ:TSLA' }
 *   "gold"      → { yahoo: 'GC=F',     tv: 'TVC:GOLD' }
 *   "S&P"       → { yahoo: '^GSPC',    tv: 'SP:SPX' }
 *   "EURUSD"    → { yahoo: 'EURUSD=X', tv: 'FX:EURUSD' }
 *   "BTC-USD"   → already Yahoo form, also build TV
 *   "NASDAQ:AAPL" → already TV form, also build Yahoo
 */
function resolveAssetSymbols(raw: string): { yahoo: string; tv: string; label: string } {
  const s = raw.trim();
  const upper = s.toUpperCase();

  // Loose natural-language map (single source of truth for both sides)
  const NL: Record<string, { y: string; tv: string; label: string }> = {
    BITCOIN:    { y: 'BTC-USD',  tv: 'BINANCE:BTCUSDT', label: 'Bitcoin' },
    BTC:        { y: 'BTC-USD',  tv: 'BINANCE:BTCUSDT', label: 'Bitcoin' },
    ETHEREUM:   { y: 'ETH-USD',  tv: 'BINANCE:ETHUSDT', label: 'Ethereum' },
    ETH:        { y: 'ETH-USD',  tv: 'BINANCE:ETHUSDT', label: 'Ethereum' },
    SOLANA:     { y: 'SOL-USD',  tv: 'BINANCE:SOLUSDT', label: 'Solana' },
    SOL:        { y: 'SOL-USD',  tv: 'BINANCE:SOLUSDT', label: 'Solana' },
    DOGECOIN:   { y: 'DOGE-USD', tv: 'BINANCE:DOGEUSDT', label: 'Dogecoin' },
    DOGE:       { y: 'DOGE-USD', tv: 'BINANCE:DOGEUSDT', label: 'Dogecoin' },
    XRP:        { y: 'XRP-USD',  tv: 'BINANCE:XRPUSDT', label: 'XRP' },
    CARDANO:    { y: 'ADA-USD',  tv: 'BINANCE:ADAUSDT', label: 'Cardano' },
    ADA:        { y: 'ADA-USD',  tv: 'BINANCE:ADAUSDT', label: 'Cardano' },

    GOLD:       { y: 'GC=F',     tv: 'TVC:GOLD',        label: 'Gold' },
    SILVER:     { y: 'SI=F',     tv: 'TVC:SILVER',      label: 'Silver' },
    COPPER:     { y: 'HG=F',     tv: 'COMEX:HG1!',      label: 'Copper' },
    OIL:        { y: 'CL=F',     tv: 'TVC:USOIL',       label: 'WTI Crude Oil' },
    CRUDE:      { y: 'CL=F',     tv: 'TVC:USOIL',       label: 'WTI Crude Oil' },
    BRENT:      { y: 'BZ=F',     tv: 'TVC:UKOIL',       label: 'Brent Oil' },
    'NATURAL GAS': { y: 'NG=F',  tv: 'NYMEX:NG1!',      label: 'Natural Gas' },

    'S&P':      { y: '^GSPC',    tv: 'SP:SPX',          label: 'S&P 500' },
    'S&P 500':  { y: '^GSPC',    tv: 'SP:SPX',          label: 'S&P 500' },
    SPX:        { y: '^GSPC',    tv: 'SP:SPX',          label: 'S&P 500' },
    NASDAQ:     { y: '^IXIC',    tv: 'NASDAQ:IXIC',     label: 'Nasdaq Composite' },
    DOW:        { y: '^DJI',     tv: 'TVC:DJI',         label: 'Dow Jones' },
    'DOW JONES':{ y: '^DJI',     tv: 'TVC:DJI',         label: 'Dow Jones' },
    VIX:        { y: '^VIX',     tv: 'TVC:VIX',         label: 'VIX' },
    NIFTY:      { y: '^NSEI',    tv: 'NSE:NIFTY',       label: 'Nifty 50' },
    SENSEX:     { y: '^BSESN',   tv: 'BSE:SENSEX',      label: 'BSE Sensex' },
    NIKKEI:     { y: '^N225',    tv: 'TVC:NI225',       label: 'Nikkei 225' },
    FTSE:       { y: '^FTSE',    tv: 'TVC:UKX',         label: 'FTSE 100' },
    DAX:        { y: '^GDAXI',   tv: 'TVC:DEU40',       label: 'DAX' },

    TESLA:      { y: 'TSLA',     tv: 'NASDAQ:TSLA',     label: 'Tesla' },
    APPLE:      { y: 'AAPL',     tv: 'NASDAQ:AAPL',     label: 'Apple' },
    MICROSOFT:  { y: 'MSFT',     tv: 'NASDAQ:MSFT',     label: 'Microsoft' },
    NVIDIA:     { y: 'NVDA',     tv: 'NASDAQ:NVDA',     label: 'Nvidia' },
    AMAZON:     { y: 'AMZN',     tv: 'NASDAQ:AMZN',     label: 'Amazon' },
    GOOGLE:     { y: 'GOOGL',    tv: 'NASDAQ:GOOGL',    label: 'Alphabet' },
    ALPHABET:   { y: 'GOOGL',    tv: 'NASDAQ:GOOGL',    label: 'Alphabet' },
    META:       { y: 'META',     tv: 'NASDAQ:META',     label: 'Meta' },
    NETFLIX:    { y: 'NFLX',     tv: 'NASDAQ:NFLX',     label: 'Netflix' },
    AMD:        { y: 'AMD',      tv: 'NASDAQ:AMD',      label: 'AMD' },
  };
  if (NL[upper]) return { yahoo: NL[upper].y, tv: NL[upper].tv, label: NL[upper].label };

  // Already a Yahoo ticker?
  if (/-USD$/i.test(upper) || /=X$/i.test(upper) || /=F$/i.test(upper) || /^\^/.test(upper) || /^[A-Z][A-Z.-]{0,9}$/.test(upper)) {
    return { yahoo: upper, tv: toTradingViewSymbol(upper), label: upper };
  }
  // TV form like NASDAQ:AAPL — extract the right side as Yahoo
  if (s.includes(':')) {
    const right = s.split(':')[1] ?? '';
    return { yahoo: right.replace(/USDT$/i, '-USD'), tv: upper, label: right };
  }
  // Bare word — try both as US stock
  return { yahoo: upper, tv: `NASDAQ:${upper}`, label: upper };
}

async function showAsset(symbolRaw: string, interval: string): Promise<unknown> {
  if (!symbolRaw) return { error: 'No symbol given' };
  const { yahoo: yahooSym, tv: tvSym, label } = resolveAssetSymbols(symbolRaw);

  // Fire both in PARALLEL. The chart panel opens immediately (just an iframe
  // load); the quote tile fetches a real-time price. The user sees both
  // appear at roughly the same moment.
  const [priceRes] = await Promise.all([
    getMarketPrice(yahooSym),
    Promise.resolve(openChart(tvSym, interval)),
  ]);

  return {
    ok: true,
    label,
    yahoo: yahooSym,
    tradingview: tvSym,
    price: priceRes,
  };
}

function openChart(symbolRaw: string, interval: string): unknown {
  if (!symbolRaw) return { error: 'No symbol given' };
  const tvSym = toTradingViewSymbol(symbolRaw);
  if (!tvSym) return { error: `Could not resolve "${symbolRaw}" to a TradingView symbol` };

  openArgusPanel({
    kind: 'chart',
    title: 'CHART',
    headline: tvSym,
    subtitle: `TRADINGVIEW · ${interval === '60' ? '1H' : interval === '240' ? '4H' : interval} BARS`,
    chart: { symbol: tvSym, interval, theme: 'dark' },
  });

  return { ok: true, symbol: tvSym, interval };
}

function openWatchlist(symbols: string[]): unknown {
  const cleaned = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 24);
  if (cleaned.length === 0) return { error: 'No symbols given' };
  openArgusPanel({
    kind: 'watchlist',
    title: 'WATCHLIST',
    headline: `${cleaned.length} SYMBOL${cleaned.length === 1 ? '' : 'S'}`,
    subtitle: 'LIVE · 6s REFRESH',
    watchlist: { symbols: cleaned, refreshMs: 6000 },
  });
  return { ok: true, count: cleaned.length, symbols: cleaned };
}

async function openSectorHeatmap(): Promise<unknown> {
  const syms = SECTOR_ETFS.map((s) => s.symbol);

  const panelId = openArgusPanel({
    kind: 'heatmap',
    title: 'SECTOR HEATMAP',
    headline: 'US SECTORS',
    subtitle: 'FETCHING…',
    loading: true,
  });

  const data = await fetchJsonWithTimeout<{ quotes?: Array<{ symbol: string; price: number; change: number }> }>(
    `/api/market/v1/list-market-quotes?symbols=${syms.join(',')}`,
  );
  const byKey = new Map<string, { price: number; change: number }>();
  for (const q of data?.quotes ?? []) byKey.set(q.symbol.toUpperCase(), { price: q.price, change: q.change });

  const cells = SECTOR_ETFS.map((s) => {
    const q = byKey.get(s.symbol.toUpperCase());
    return {
      label: s.label,
      sub:   s.sub,
      value: q?.price ?? 0,
      change: q?.change ?? 0,
    };
  });
  const fetched = SECTOR_ETFS.filter((s) => byKey.has(s.symbol.toUpperCase())).length;

  updateArgusPanel(panelId, {
    kind: 'heatmap',
    subtitle: fetched === 0 ? 'NO LIVE DATA' : 'TODAY · SPDR ETFs',
    loading: false,
    heatmap: { cells },
  });
  return { ok: fetched > 0, count: fetched };
}

async function showTopMovers(direction: string, count: number): Promise<unknown> {
  const want = direction === 'down' ? 'down' : 'up';
  const limit = Math.max(1, Math.min(20, Math.round(count) || 8));

  const panelId = openArgusPanel({
    kind: 'watchlist',
    title: want === 'up' ? 'TOP GAINERS' : 'TOP LOSERS',
    headline: 'SCANNING…',
    subtitle: 'FETCHING…',
    loading: true,
  });

  const universe = await getMoversUniverse();
  const data = await fetchJsonWithTimeout<{ quotes?: Array<{ symbol: string; price: number; change: number }> }>(
    `/api/market/v1/list-market-quotes?symbols=${universe.join(',')}`,
    // Top-movers scans many symbols — give the backend a slightly longer window
    7000,
  );
  const all = (data?.quotes ?? []).filter((q) => Number.isFinite(q.change));
  all.sort((a, b) => want === 'up' ? b.change - a.change : a.change - b.change);
  const top = all.slice(0, limit);
  const symbols = top.map((q) => q.symbol.toUpperCase());

  updateArgusPanel(panelId, {
    kind: 'watchlist',
    headline: `${top.length} ${want === 'up' ? 'GAINERS' : 'LOSERS'}`,
    subtitle: symbols.length === 0
      ? 'NO LIVE DATA'
      : `LIVE · SCANNED ${universe.length} NAMES`,
    loading: false,
    watchlist: { symbols, refreshMs: 8000 },
  });

  return { ok: top.length > 0, direction: want, count: top.length, scanned: universe.length, top: top.map((q) => ({ symbol: q.symbol, price: q.price, change: q.change })) };
}

/**
 * Compare 2+ symbols side by side as a live watchlist. Marketed as "compare"
 * vs "watchlist" so ARGUS picks the right phrasing in conversation, but uses
 * the same renderer so the user gets an instant visual side-by-side.
 */
function compareSymbols(symbols: string[]): unknown {
  const cleaned = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 8);
  if (cleaned.length < 2) return { error: 'Need at least 2 symbols to compare' };
  openArgusPanel({
    kind: 'watchlist',
    title: 'COMPARE',
    headline: cleaned.join(' VS '),
    subtitle: 'LIVE · SIDE BY SIDE',
    watchlist: { symbols: cleaned, refreshMs: 6000 },
  });
  return { ok: true, comparing: cleaned };
}

/**
 * Convert ANY amount of one currency or asset to another using live Yahoo
 * rates. Supports fiat-fiat (USD↔INR), crypto-fiat (BTC↔USD), and crypto-crypto
 * (BTC↔ETH) by chaining through USD when needed.
 */
async function convertCurrency(amount: number, from: string, to: string): Promise<unknown> {
  if (!Number.isFinite(amount) || amount === 0) return { error: 'Invalid amount' };
  const src = from.trim().toUpperCase();
  const dst = to.trim().toUpperCase();
  if (!src || !dst) return { error: 'Need both from and to' };
  if (src === dst) return { ok: true, amount, from: src, to: dst, result: amount, summary: `${amount} ${src} is ${amount} ${src}.` };

  const isFiat = (s: string) => /^[A-Z]{3}$/.test(s);
  const isCryptoTicker = (s: string) => /^(BTC|ETH|SOL|XRP|DOGE|ADA|MATIC|AVAX|LINK|DOT|TON|BNB|TRX|LTC|BCH|ATOM|XLM|HBAR|NEAR|FIL|SUI|APT|INJ|TIA)$/.test(s);

  // Open with skeleton so the user sees the panel before rates land.
  const panelId = openArgusPanel({
    kind: 'kv',
    title: 'CONVERT',
    headline: `${amount.toLocaleString()} ${src}`,
    subtitle: `→ ${dst}`,
    loading: true,
  });

  async function rateUsdPer(ticker: string): Promise<number | null> {
    if (ticker === 'USD') return 1;
    let sym = '';
    if (isCryptoTicker(ticker)) sym = `${ticker}-USD`;
    else if (isFiat(ticker))    sym = `${ticker}USD=X`;
    else return null;
    const data = await fetchJsonWithTimeout<{ quotes?: Array<{ symbol: string; price: number }> }>(
      `/api/market/v1/list-market-quotes?symbols=${sym}`,
    );
    return data?.quotes?.[0]?.price ?? null;
  }

  const [usdPerSrc, usdPerDst] = await Promise.all([rateUsdPer(src), rateUsdPer(dst)]);
  if (usdPerSrc == null || usdPerDst == null) {
    updateArgusPanel(panelId, {
      kind: 'kv',
      subtitle: 'NO LIVE RATE',
      loading: false,
      kv: [{ label: 'Status', value: `Couldn't price ${src} or ${dst}` }],
    });
    return { ok: false, summary: `Couldn't pull a live rate for ${src}/${dst}.` };
  }
  const usdValue = amount * usdPerSrc;
  const result = usdValue / usdPerDst;

  updateArgusPanel(panelId, {
    kind: 'kv',
    loading: false,
    kv: [
      { label: 'Result',  value: `${result.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${dst}` },
      { label: 'Rate',    value: `1 ${src} = ${(usdPerSrc / usdPerDst).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${dst}` },
      { label: 'Via USD', value: `${usdValue.toLocaleString(undefined, { maximumFractionDigits: 2 })} USD` },
    ],
  });

  return {
    ok: true,
    amount, from: src, to: dst,
    result,
    rate: usdPerSrc / usdPerDst,
    summary: `${amount} ${src} is ${result.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${dst}.`,
  };
}

// ─── SYSTEM ─────────────────────────────────────────────────────────────────

function setMapLayer(layerId: string, enabled: boolean): unknown {
  if (!layerId) return { error: 'No layer ID' };
  requestChatMode(); // Layer toggle affects the dashboard map — let the user see
  document.dispatchEvent(new CustomEvent('wm:goat-set-layer', { detail: { layerId, enabled } }));
  return { ok: true, layerId, enabled };
}

function switchTheme(theme: string): unknown {
  if (theme !== 'dark' && theme !== 'light') return { error: 'Invalid theme' };
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('alsaglobal-theme', theme); } catch { /* ignore */ }
  return { ok: true, theme };
}

// ─── Utils ──────────────────────────────────────────────────────────────────

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(/[,\s]+/).filter(Boolean);
  return [];
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
