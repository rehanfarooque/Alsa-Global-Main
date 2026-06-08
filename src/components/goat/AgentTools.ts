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
import { openArgusPanel, closeAllArgusPanels, maximizeArgusPanel, restoreArgusPanel } from './ArgusPanel';

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
      description: 'Closes every open panel on the dashboard. Useful as a reset before opening a focused set.',
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
        case 'showMarketOverview':  return showMarketOverview();
        case 'showCriticalNews':    return showCriticalNews(ctx);
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
    try {
      const syms = ['^GSPC', '^IXIC', '^DJI', '^VIX', 'BTC-USD', 'ETH-USD', 'GC=F', 'CL=F'];
      const res = await fetch(`/api/market/v1/list-market-quotes?symbols=${syms.join(',')}`);
      if (res.ok) {
        const data = await res.json() as { quotes?: Array<{ symbol: string; price: number; change: number }> };
        const kv = (data.quotes ?? []).map((q) => ({
          label: q.symbol,
          value: `${q.price.toFixed(2)}  ${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)}%`,
        }));
        if (kv.length > 0) {
          openArgusPanel({
            kind: 'kv',
            title: 'MARKET OVERVIEW',
            headline: 'MAJOR MARKETS',
            subtitle: 'LIVE QUOTES',
            kv,
          });
          return { ok: true, panelId, message: `Showing ${kv.length} major markets live.`, source: 'market-fallback' };
        }
      }
    } catch { /* fall through */ }
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

function closeAllPanels(): { ok: boolean; closed: number; argusClosed: number } {
  const els = document.querySelectorAll<HTMLElement>('[data-panel]');
  let count = 0;
  els.forEach((el) => {
    el.dispatchEvent(new CustomEvent('wm:panel-close', { bubbles: true, detail: { panelId: el.dataset.panel } }));
    count++;
  });
  const argusClosed = closeAllArgusPanels();
  return { ok: true, closed: count, argusClosed };
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
  try {
    const resp = await fetch(`/api/market/v1/list-market-quotes?symbols=${encodeURIComponent(sym)}`);
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    const data = await resp.json() as { quotes?: Array<{ symbol: string; price: number; change: number }> };
    const q = data.quotes?.find((x) => x.symbol.toUpperCase() === sym) ?? data.quotes?.[0];
    if (!q) return { symbol: sym, error: 'No price data available' };
    // Pop the floating panel so the user SEES the result, not just hears it.
    // Crypto / FX / futures get live ticker mode — price refreshes every 5s with
    // animated flash and a growing sparkline. Stocks/indices: static (they
    // change slowly outside market hours so a tick every 5s would be all flat).
    const isLiveTickerSymbol =
      /-USD$/i.test(q.symbol) ||      // crypto: BTC-USD, ETH-USD
      /=X$/i.test(q.symbol) ||         // forex: EURUSD=X
      /=F$/i.test(q.symbol);           // futures: GC=F, CL=F
    openArgusPanel({
      kind: 'quote',
      title: 'MARKET QUOTE',
      headline: q.symbol,
      subtitle: isLiveTickerSymbol ? 'LIVE TICKER · YAHOO' : 'PRICE · YAHOO',
      quote: { symbol: q.symbol, price: q.price, changePercent: q.change },
      liveRefreshMs: isLiveTickerSymbol ? 5000 : undefined,
    });
    return {
      symbol: q.symbol,
      price: q.price,
      changePercent: q.change,
      summary: `${q.symbol} is at ${q.price.toFixed(2)}, ${q.change >= 0 ? 'up' : 'down'} ${Math.abs(q.change).toFixed(2)}%.`,
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function searchNews(ctx: AppContext, query: string, limit: number): unknown {
  const q = query.toLowerCase().trim();
  const all = ctx.allNews ?? [];
  const items = q
    ? all.filter((n) => (n.title ?? '').toLowerCase().includes(q) || (n.locationName ?? '').toLowerCase().includes(q))
    : all;
  const capped = items.slice(0, Math.max(1, Math.min(20, limit || 5)));
  const mapped = capped.map((n) => ({
    title: n.title,
    source: n.source,
    ts: n.pubDate instanceof Date ? n.pubDate.toISOString() : String(n.pubDate),
    url: n.link,
    location: n.locationName,
  }));
  // Floating panel with the matching headlines
  openArgusPanel({
    kind: 'news',
    title: 'NEWS SEARCH',
    headline: query || 'LATEST',
    subtitle: `${mapped.length} HEADLINE${mapped.length === 1 ? '' : 'S'}`,
    news: mapped.map((m) => ({ title: m.title ?? '', source: m.source, ts: m.ts, location: m.location })),
  });
  return { count: capped.length, items: mapped };
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

async function buildWidget(prompt: string): Promise<unknown> {
  if (!prompt) return { error: 'No prompt given' };
  try {
    const resp = await fetch('/widget-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, mode: 'create', tier: 'pro' }),
    });
    if (!resp.ok || !resp.body) return { error: `HTTP ${resp.status}` };
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let title = 'Custom widget';
    let html = '';
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
        } catch { /* skip */ }
      }
    }
    if (!html) return { error: 'Widget generation returned no HTML' };
    document.dispatchEvent(new CustomEvent('wm:goat-add-widget', { detail: { title, html, prompt } }));
    return { ok: true, title, message: `Built and added: ${title}` };
  } catch (err) {
    return { error: (err as Error).message };
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

async function getCountryNews(code: string, ctx: AppContext): Promise<unknown> {
  if (!code) return { error: 'No country code' };
  const cc = code.toUpperCase().slice(0, 2);
  const name = countryName(cc);
  const nameLc = name.toLowerCase();
  const all = ctx.allNews ?? [];

  const items = all.filter((n) => {
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

async function showMarketOverview(): Promise<unknown> {
  try {
    const syms = ['^GSPC', '^IXIC', '^DJI', '^VIX', 'BTC-USD', 'ETH-USD', 'GC=F', 'CL=F'];
    const res = await fetch(`/api/market/v1/list-market-quotes?symbols=${syms.join(',')}`);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json() as { quotes?: Array<{ symbol: string; price: number; change: number }> };
    const kv = (data.quotes ?? []).map((q) => ({
      label: q.symbol,
      value: `${q.price.toFixed(2)}  ${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)}%`,
    }));
    openArgusPanel({
      kind: 'kv',
      title: 'MARKET OVERVIEW',
      headline: 'MAJOR MARKETS',
      subtitle: 'LIVE QUOTES',
      kv,
    });
    return { ok: true, count: kv.length, items: data.quotes ?? [] };
  } catch (err) {
    return { error: (err as Error).message };
  }
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
