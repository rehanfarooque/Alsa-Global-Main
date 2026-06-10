/**
 * ArgusPanel — floating glass-morphic panels that ARGUS spawns when it opens
 * something or fetches data. Modeled on the AlsaTalk Campaigns panel:
 *
 *   ┌──────────────────────────────────────────┐
 *   │ 📣  TITLE                  _  ⛶  ✕      │  ← chrome
 *   │  HEADLINE                                 │
 *   │  subtitle in orange                       │
 *   │ ┌──────────────────────────────────────┐  │
 *   │ │   content                             │  │
 *   │ │   (markets / news / brief / etc.)     │  │
 *   │ └──────────────────────────────────────┘  │
 *   └──────────────────────────────────────────┘
 *
 * Each panel is draggable (mousedown on title bar), minimizable, and
 * dismissable. Up to 6 stacked at once with auto-offset so they don't
 * perfectly overlap. Older ones recede behind newer ones.
 *
 * Public API:
 *   openArgusPanel(spec)  → returns id, can be passed to closeArgusPanel
 *   closeArgusPanel(id)
 *   closeAllArgusPanels()
 */

const STYLE_ID = 'argus-panel-style';
const STYLE_CSS = `
.argus-popout-root {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 10050;
}
.argus-popout {
  position: absolute;
  pointer-events: auto;
  min-width: 320px;
  max-width: 460px;
  width: clamp(320px, 30vw, 460px);
  max-height: 70vh;
  background: linear-gradient(180deg, rgba(10, 16, 28, 0.92) 0%, rgba(4, 14, 24, 0.92) 100%);
  border: 1px solid rgba(0, 212, 255, 0.28);
  border-radius: 14px;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0, 212, 255, 0.06);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  opacity: 0;
  transform: translateY(8px) scale(0.97);
  transition: opacity 0.25s ease, transform 0.25s ease, box-shadow 0.3s ease;
}
.argus-popout.--shown { opacity: 1; transform: translateY(0) scale(1); }
.argus-popout.--minimized {
  max-height: 44px;
  min-width: 220px;
}
.argus-popout.--minimized .argus-popout-banner,
.argus-popout.--minimized .argus-popout-body { display: none; }
.argus-popout.--flash { animation: argus-popout-flash 1.4s ease-out; }

/* Maximized = nearly full-screen, modal-ish. Class hard-overrides the small
   default sizing so the panel actually feels big when user hits ⤢. */
.argus-popout.--maximized {
  top: 6vh !important;
  left: 50% !important;
  right: auto !important;
  bottom: auto !important;
  transform: translateX(-50%);
  width: min(1100px, 92vw) !important;
  max-width: min(1100px, 92vw) !important;
  height: 86vh !important;
  max-height: 86vh !important;
  z-index: 10080;
}
.argus-popout.--maximized .argus-popout-headline { font-size: 28px; }
.argus-popout.--maximized .argus-popout-body { font-size: 14px; }

@keyframes argus-popout-flash {
  0%   { box-shadow: 0 28px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,212,255,0.06); }
  30%  { box-shadow: 0 28px 80px rgba(0,0,0,0.55), 0 0 0 3px rgba(0,212,255,0.6), 0 0 36px rgba(0,212,255,0.45); }
  100% { box-shadow: 0 28px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,212,255,0.06); }
}

.argus-popout-chrome {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: rgba(0, 212, 255, 0.08);
  border-bottom: 1px solid rgba(0, 212, 255, 0.2);
  cursor: grab;
  user-select: none;
}
.argus-popout-chrome:active { cursor: grabbing; }
.argus-popout-chrome-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  letter-spacing: 0.22em;
  font-weight: 600;
  color: rgba(255, 138, 59, 0.95);
}
.argus-popout-chrome-actions { display: inline-flex; gap: 6px; }
.argus-popout-chrome-btn {
  width: 22px; height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 5px;
  color: rgba(255, 255, 255, 0.65);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.argus-popout-chrome-btn:hover {
  color: #fff;
  border-color: rgba(0, 212, 255, 0.55);
  background: rgba(0, 212, 255, 0.1);
}
.argus-popout-chrome-btn.danger:hover {
  color: #ff6b8a;
  border-color: rgba(255, 107, 138, 0.55);
  background: rgba(255, 107, 138, 0.1);
}

.argus-popout-banner {
  padding: 14px 18px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.argus-popout-headline {
  display: block;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.16em;
  color: #fff;
  text-shadow: 0 0 12px rgba(0, 212, 255, 0.35);
}
.argus-popout-subtitle {
  display: block;
  font-size: 10px;
  letter-spacing: 0.28em;
  color: rgba(255, 138, 59, 0.85);
  margin-top: 4px;
}

.argus-popout-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 18px 16px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
  line-height: 1.5;
}
.argus-popout-body::-webkit-scrollbar { width: 6px; }
.argus-popout-body::-webkit-scrollbar-thumb { background: rgba(0,212,255,0.25); border-radius: 3px; }

.argus-popout-loading {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 6px 0;
}
.argus-popout-skeleton {
  background: linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(0,212,255,0.10) 50%, rgba(255,255,255,0.04) 100%);
  background-size: 200% 100%;
  animation: argus-skeleton-shimmer 1.2s linear infinite;
  border-radius: 6px;
  height: 16px;
}
.argus-popout-skeleton.--tall { height: 38px; }
.argus-popout-skeleton.--wide { width: 70%; }
@keyframes argus-skeleton-shimmer {
  from { background-position: 200% 0; }
  to   { background-position: -200% 0; }
}

.argus-popout-stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
.argus-popout-stat {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 10px 12px;
}
.argus-popout-stat-label {
  font-size: 9px;
  letter-spacing: 0.2em;
  color: rgba(255, 255, 255, 0.5);
}
.argus-popout-stat-value {
  font-size: 18px;
  font-weight: 700;
  color: #fff;
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
}
.argus-popout-stat-value.--up    { color: #58e6c8; }
.argus-popout-stat-value.--down  { color: #ff6b8a; }

.argus-popout-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.argus-popout-list-item {
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  transition: border-color 0.2s ease;
}
.argus-popout-list-item:hover { border-color: rgba(0, 212, 255, 0.35); }
.argus-popout-list-title {
  font-size: 13px;
  color: #fff;
  margin-bottom: 4px;
  line-height: 1.4;
}
.argus-popout-list-meta {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  letter-spacing: 0.04em;
}

.argus-popout-kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  font-size: 12px;
}
.argus-popout-kv dt {
  color: rgba(255, 255, 255, 0.55);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  font-size: 10px;
  align-self: center;
}
.argus-popout-kv dd {
  margin: 0;
  color: #fff;
  font-variant-numeric: tabular-nums;
}

.argus-popout-empty {
  color: rgba(255, 255, 255, 0.45);
  font-size: 12px;
  padding: 18px 0;
  text-align: center;
}

/* ── Watchlist (each symbol is a mini row with sparkline) ──────────────── */
.argus-watchlist {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.argus-watch-row {
  display: grid;
  grid-template-rows: auto auto;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  transition: border-color 0.18s ease, background 0.18s ease;
}
.argus-watch-row:hover {
  border-color: rgba(0, 212, 255, 0.35);
  background: rgba(0, 212, 255, 0.04);
}
.argus-watch-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.argus-watch-sym {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #fff;
}
.argus-watch-px {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  font-variant-numeric: tabular-nums;
}
.argus-watch-meta {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}
.argus-watch-spark {
  width: 100%;
  height: 24px;
}
.argus-watch-spark .spark-line.--up   { fill: none; stroke: #58e6c8; stroke-width: 1.6; }
.argus-watch-spark .spark-line.--down { fill: none; stroke: #ff6b8a; stroke-width: 1.6; }
.argus-watch-spark .spark-area.--up   { fill: rgba(88, 230, 200, 0.14); stroke: none; }
.argus-watch-spark .spark-area.--down { fill: rgba(255, 107, 138, 0.12); stroke: none; }
.argus-watch-chg {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  min-width: 70px;
  text-align: right;
}
.argus-watch-chg.--up   { color: #58e6c8; }
.argus-watch-chg.--down { color: #ff6b8a; }

/* ── Sector heatmap grid ─────────────────────────────────────────────── */
.argus-heatmap {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}
.argus-heat-cell {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  transition: transform 0.18s ease;
  min-height: 76px;
  justify-content: space-between;
}
.argus-heat-cell:hover { transform: scale(1.03); }
.argus-heat-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #fff;
  line-height: 1.1;
}
.argus-heat-sub {
  font-size: 9px;
  letter-spacing: 0.18em;
  color: rgba(255, 255, 255, 0.55);
}
.argus-heat-pct {
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  margin-top: 4px;
}
.argus-heat-pct.--up   { color: #58e6c8; }
.argus-heat-pct.--down { color: #ff8aa3; }

/* ── TradingView chart embed ──────────────────────────────────────────── */
.argus-popout[data-kind="chart"] {
  width: clamp(420px, 50vw, 820px) !important;
  max-width: 90vw;
}
.argus-popout[data-kind="chart"] .argus-popout-body { padding: 0; }
.argus-chart-wrap {
  width: 100%;
  height: 100%;
  min-height: 360px;
  display: block;
  position: relative;
  overflow: hidden;
  border-radius: 0 0 14px 14px;
}
.argus-chart-frame {
  width: 100%;
  height: 100%;
  min-height: 360px;
  border: 0;
  display: block;
  background: #0a0e16;
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_CSS;
  document.head.appendChild(style);
}

function ensureRoot(): HTMLElement {
  let root = document.getElementById('argus-popout-root') as HTMLElement | null;
  if (root) return root;
  root = document.createElement('div');
  root.id = 'argus-popout-root';
  root.className = 'argus-popout-root';
  document.body.appendChild(root);
  return root;
}

// ─── Spec types ─────────────────────────────────────────────────────────────

export type ArgusPanelKind = 'quote' | 'news' | 'brief' | 'kv' | 'text' | 'panel-confirm' | 'watchlist' | 'heatmap' | 'chart';

export interface ArgusPanelSpec {
  id?: string;
  kind: ArgusPanelKind;
  title: string;          // chrome title (caps, e.g. "MARKET QUOTE")
  headline?: string;      // big headline (e.g. "BTC-USD")
  subtitle?: string;      // orange subtitle (e.g. "LIVE PRICE")
  // Content for each kind:
  quote?:  { symbol: string; price: number; changePercent: number; currency?: string };
  news?:   Array<{ title: string; source?: string; ts?: string; location?: string }>;
  brief?:  { macroSummary?: string | null; topHeadlines: Array<{ title: string; source?: string; location?: string }>; count: number };
  kv?:     Array<{ label: string; value: string }>;
  text?:   string;
  confirm?: { panelId: string; name?: string };
  /** Auto-refresh the quote every N ms via the list-market-quotes endpoint, animating each tick. */
  liveRefreshMs?: number;
  /** A watchlist of symbols — each rendered as a mini card with price + change + sparkline. */
  watchlist?: { symbols: string[]; refreshMs?: number };
  /** A heatmap grid — each cell is colour-graded by `change` (% gain/loss). */
  heatmap?: { cells: Array<{ label: string; value: number; change: number; sub?: string }> };
  /** TradingView embedded chart. symbol uses TradingView form: BINANCE:BTCUSDT, NASDAQ:AAPL, FX:EURUSD, etc. */
  chart?: { symbol: string; interval?: string; theme?: 'dark' | 'light' };
  /** Render a skeleton instead of the kind-specific body. Used when the panel
   *  is shown FIRST and data lands later via updateArgusPanel(). */
  loading?: boolean;
}

// ─── State ──────────────────────────────────────────────────────────────────

interface PanelMeta {
  el: HTMLElement;
  liveTimer?: ReturnType<typeof setInterval>;
  priceHistory?: number[]; // for single-quote sparkline
  watchHistory?: Map<string, number[]>; // per-symbol sparkline for watchlist
  /** Content fingerprint — if a new openArgusPanel call has the same key, we close the old first. */
  dedupeKey: string;
}
const openPanels = new Map<string, PanelMeta>();
let panelCount = 0;

/** Same kind+headline+subtitle = same logical panel. Re-opening replaces the old one. */
function makeDedupeKey(spec: ArgusPanelSpec): string {
  return `${spec.kind}::${(spec.headline ?? '').toLowerCase()}::${(spec.title ?? '').toLowerCase()}`;
}

const MAX_PANELS = 6;

function genId(): string {
  return `argus-pop-${Date.now().toString(36)}-${(++panelCount).toString(36)}`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function fmtPrice(n: number, ccy?: string): string {
  if (!Number.isFinite(n)) return '—';
  const opts: Intl.NumberFormatOptions = { maximumFractionDigits: n >= 1000 ? 2 : 4, minimumFractionDigits: 2 };
  const str = n.toLocaleString('en-US', opts);
  return ccy && ccy !== 'USD' ? `${str} ${ccy}` : `$${str}`;
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtRelTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

// ─── Content rendering ──────────────────────────────────────────────────────

function renderQuote(q: ArgusPanelSpec['quote'], live: boolean): string {
  if (!q) return `<div class="argus-popout-empty">No quote data.</div>`;
  const up = q.changePercent >= 0;
  return `
    <div class="argus-popout-stat-row">
      <div class="argus-popout-stat" data-stat="price">
        <div class="argus-popout-stat-label">PRICE${live ? '<span class="argus-popout-live-pill">LIVE</span>' : ''}</div>
        <div class="argus-popout-stat-value" data-price>${escape(fmtPrice(q.price, q.currency))}</div>
      </div>
      <div class="argus-popout-stat" data-stat="change">
        <div class="argus-popout-stat-label">24H CHANGE</div>
        <div class="argus-popout-stat-value ${up ? '--up' : '--down'}" data-change>${escape(fmtPct(q.changePercent))}</div>
      </div>
    </div>
    <svg class="argus-popout-spark" viewBox="0 0 200 56" preserveAspectRatio="none" data-spark>
      <path class="spark-area ${up ? '--up' : '--down'}" data-spark-area d="" />
      <path class="spark-line ${up ? '--up' : '--down'}" data-spark-line d="" />
    </svg>
    <dl class="argus-popout-kv">
      <dt>Symbol</dt><dd data-sym>${escape(q.symbol)}</dd>
      <dt>Updated</dt><dd data-updated>${new Date().toLocaleTimeString()}</dd>
    </dl>
  `;
}

function renderNews(items: ArgusPanelSpec['news']): string {
  if (!items || items.length === 0) return `<div class="argus-popout-empty">No matching items.</div>`;
  return `<div class="argus-popout-list">${items.map((n) => `
    <div class="argus-popout-list-item">
      <div class="argus-popout-list-title">${escape(n.title ?? '')}</div>
      <div class="argus-popout-list-meta">
        ${n.source ? escape(n.source) : 'unknown source'}
        ${n.location ? ` · ${escape(n.location)}` : ''}
        ${n.ts ? ` · ${escape(fmtRelTime(n.ts))}` : ''}
      </div>
    </div>
  `).join('')}</div>`;
}

function renderBrief(b: ArgusPanelSpec['brief']): string {
  if (!b) return `<div class="argus-popout-empty">No brief.</div>`;
  let out = '';
  if (b.macroSummary) {
    out += `<div class="argus-popout-list-item" style="margin-bottom:10px;">
      <div class="argus-popout-list-meta" style="margin-bottom:4px;">MACRO</div>
      <div class="argus-popout-list-title">${escape(b.macroSummary)}</div>
    </div>`;
  }
  out += renderNews(b.topHeadlines || []);
  return out;
}

function renderKv(kv: ArgusPanelSpec['kv']): string {
  if (!kv || kv.length === 0) return `<div class="argus-popout-empty">No data.</div>`;
  return `<dl class="argus-popout-kv">${kv.map((row) =>
    `<dt>${escape(row.label)}</dt><dd>${escape(row.value)}</dd>`,
  ).join('')}</dl>`;
}

function renderConfirm(c: ArgusPanelSpec['confirm']): string {
  if (!c) return '';
  return `<div class="argus-popout-empty" style="text-align:left;color:rgba(255,255,255,0.85);">
    Opened <strong>${escape(c.name || c.panelId)}</strong> on the dashboard.
  </div>`;
}

function renderBody(spec: ArgusPanelSpec): string {
  if (spec.loading) return renderLoading(spec.kind);
  switch (spec.kind) {
    case 'quote':         return renderQuote(spec.quote, !!spec.liveRefreshMs);
    case 'news':          return renderNews(spec.news);
    case 'brief':         return renderBrief(spec.brief);
    case 'kv':            return renderKv(spec.kv);
    case 'text':          return `<div>${escape(spec.text ?? '')}</div>`;
    case 'panel-confirm': return renderConfirm(spec.confirm);
    case 'watchlist':     return renderWatchlist(spec.watchlist);
    case 'heatmap':       return renderHeatmap(spec.heatmap);
    case 'chart':         return renderChart(spec.chart);
  }
}

function renderLoading(kind: ArgusPanelKind): string {
  if (kind === 'quote') {
    return `<div class="argus-popout-loading">
      <div class="argus-popout-skeleton --tall"></div>
      <div class="argus-popout-skeleton --wide"></div>
      <div class="argus-popout-skeleton"></div>
    </div>`;
  }
  return `<div class="argus-popout-loading">
    <div class="argus-popout-skeleton"></div>
    <div class="argus-popout-skeleton --wide"></div>
    <div class="argus-popout-skeleton"></div>
    <div class="argus-popout-skeleton --wide"></div>
  </div>`;
}

/**
 * Embed a TradingView Advanced Chart for the given symbol. Uses the free
 * widget iframe so no auth / API key needed. Symbol must be TradingView form
 * (EXCHANGE:TICKER) — see tools/AgentTools.ts for the natural-language map.
 */
function renderChart(c: ArgusPanelSpec['chart']): string {
  if (!c?.symbol) return `<div class="argus-popout-empty">No symbol given.</div>`;
  // TradingView interval codes: 1, 5, 15, 60 (1h), 240 (4h), D, W, M
  const interval = c.interval ?? '60';
  const theme = c.theme ?? 'dark';
  // tradingview.com/widgetembed/ is the lightweight iframe form. No
  // post-message scripting required, just URL params.
  const sym = encodeURIComponent(c.symbol);
  const src = `https://s.tradingview.com/widgetembed/?frameElementId=tradingview-${Date.now()}` +
              `&symbol=${sym}&interval=${interval}&hidesidetoolbar=1&symboledit=1` +
              `&saveimage=0&toolbarbg=0a0e16&studies=[]&theme=${theme}&style=1` +
              `&timezone=Etc%2FUTC&withdateranges=1&hideideas=1` +
              `&studies_overrides={}&overrides={}&enabled_features=[]&disabled_features=[]&locale=en`;
  return `
    <div class="argus-chart-wrap">
      <iframe class="argus-chart-frame"
              src="${src}"
              loading="lazy"
              referrerpolicy="no-referrer"
              allowtransparency="true"
              allow="clipboard-write"
              title="TradingView chart for ${escape(c.symbol)}"></iframe>
    </div>
  `;
}

function renderWatchlist(w: ArgusPanelSpec['watchlist']): string {
  if (!w || w.symbols.length === 0) return `<div class="argus-popout-empty">No symbols.</div>`;
  const items = w.symbols.map((sym) => `
    <div class="argus-watch-row" data-watch-sym="${escape(sym)}">
      <div class="argus-watch-head">
        <span class="argus-watch-sym">${escape(sym)}</span>
        <span class="argus-watch-px" data-watch-px>—</span>
      </div>
      <div class="argus-watch-meta">
        <svg class="argus-watch-spark" viewBox="0 0 120 28" preserveAspectRatio="none" data-watch-spark>
          <path class="spark-area" data-watch-area d="" />
          <path class="spark-line" data-watch-line d="" />
        </svg>
        <span class="argus-watch-chg" data-watch-chg>—</span>
      </div>
    </div>
  `).join('');
  return `<div class="argus-watchlist">${items}</div>`;
}

function renderHeatmap(h: ArgusPanelSpec['heatmap']): string {
  if (!h || h.cells.length === 0) return `<div class="argus-popout-empty">No data.</div>`;
  const cells = h.cells.map((c) => {
    // Colour intensity by change %: cap at ±5% for visual range
    const clamped = Math.max(-5, Math.min(5, c.change));
    const t = Math.abs(clamped) / 5;     // 0..1
    const baseColor = c.change >= 0 ? '88, 230, 200' : '255, 107, 138';
    const bg = `rgba(${baseColor}, ${(0.12 + t * 0.45).toFixed(2)})`;
    const arrow = c.change >= 0 ? '▲' : '▼';
    return `
      <div class="argus-heat-cell" style="background:${bg};border-color:rgba(${baseColor},${(0.35 + t * 0.4).toFixed(2)})">
        <div class="argus-heat-label">${escape(c.label)}</div>
        ${c.sub ? `<div class="argus-heat-sub">${escape(c.sub)}</div>` : ''}
        <div class="argus-heat-pct ${c.change >= 0 ? '--up' : '--down'}">${arrow} ${Math.abs(c.change).toFixed(2)}%</div>
      </div>
    `;
  }).join('');
  return `<div class="argus-heatmap">${cells}</div>`;
}

/** Build sparkline path strings from price history. */
function buildSparkPaths(history: number[]): { line: string; area: string } {
  if (history.length < 2) return { line: '', area: '' };
  const min = Math.min(...history);
  const max = Math.max(...history);
  const span = max - min || 1;
  const W = 200, H = 56, PAD = 2;
  const points = history.map((v, i) => {
    const x = (i / (history.length - 1)) * (W - PAD * 2) + PAD;
    const y = H - PAD - ((v - min) / span) * (H - PAD * 2);
    return [x, y] as const;
  });
  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const area = `M${first[0].toFixed(1)},${H - PAD} ${line.replace(/^M/, 'L')} L${last[0].toFixed(1)},${H - PAD} Z`;
  return { line, area };
}

/** Refresh a live watchlist panel — parallel-fetches all symbols, animates each row. */
async function refreshWatchlistPanel(id: string, symbols: string[]): Promise<void> {
  const meta = openPanels.get(id);
  if (!meta) return;
  try {
    const res = await fetch(`/api/market/v1/list-market-quotes?symbols=${symbols.join(',')}`);
    if (!res.ok) return;
    const data = await res.json() as { quotes?: Array<{ symbol: string; price: number; change: number }> };
    const byKey = new Map<string, { price: number; change: number }>();
    for (const q of data.quotes ?? []) byKey.set(q.symbol.toUpperCase(), { price: q.price, change: q.change });

    if (!meta.watchHistory) meta.watchHistory = new Map();

    for (const sym of symbols) {
      const row = meta.el.querySelector<HTMLElement>(`[data-watch-sym="${cssAttrEscape(sym)}"]`);
      if (!row) continue;
      const q = byKey.get(sym.toUpperCase());
      if (!q) continue;

      // Track per-symbol price history for the mini sparkline
      let hist = meta.watchHistory.get(sym) ?? [];
      hist.push(q.price);
      if (hist.length > 30) hist = hist.slice(-30);
      meta.watchHistory.set(sym, hist);

      // Update DOM
      const pxEl = row.querySelector<HTMLElement>('[data-watch-px]');
      const chgEl = row.querySelector<HTMLElement>('[data-watch-chg]');
      const lineEl = row.querySelector<SVGPathElement>('[data-watch-line]');
      const areaEl = row.querySelector<SVGPathElement>('[data-watch-area]');
      if (pxEl) pxEl.textContent = fmtPrice(q.price);
      if (chgEl) {
        chgEl.textContent = `${q.change >= 0 ? '▲' : '▼'} ${Math.abs(q.change).toFixed(2)}%`;
        chgEl.classList.toggle('--up', q.change >= 0);
        chgEl.classList.toggle('--down', q.change < 0);
      }
      if (lineEl && areaEl && hist.length > 1) {
        const { line, area } = buildSparkPathsForBox(hist, 120, 28);
        lineEl.setAttribute('d', line);
        areaEl.setAttribute('d', area);
        const dirClass = q.change >= 0 ? '--up' : '--down';
        lineEl.classList.remove('--up', '--down'); lineEl.classList.add(dirClass);
        areaEl.classList.remove('--up', '--down'); areaEl.classList.add(dirClass);
      }
    }
  } catch {
    // best-effort — keep panel visible
  }
}

/** Escape a value for use inside a CSS attribute selector. */
function cssAttrEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

/** Sparkline paths sized to an arbitrary box. */
function buildSparkPathsForBox(history: number[], W: number, H: number): { line: string; area: string } {
  if (history.length < 2) return { line: '', area: '' };
  const min = Math.min(...history);
  const max = Math.max(...history);
  const span = max - min || 1;
  const PAD = 2;
  const pts = history.map((v, i) => {
    const x = (i / (history.length - 1)) * (W - PAD * 2) + PAD;
    const y = H - PAD - ((v - min) / span) * (H - PAD * 2);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const area = `M${first[0].toFixed(1)},${H - PAD} ${line.replace(/^M/, 'L')} L${last[0].toFixed(1)},${H - PAD} Z`;
  return { line, area };
}

/** Refresh a live quote panel in place — fetches latest price, animates the change. */
async function refreshLivePanel(id: string, symbol: string): Promise<void> {
  const meta = openPanels.get(id);
  if (!meta) return;
  try {
    const res = await fetch(`/api/market/v1/list-market-quotes?symbols=${encodeURIComponent(symbol)}`);
    if (!res.ok) return;
    const data = await res.json() as { quotes?: Array<{ symbol: string; price: number; change: number }> };
    const q = data.quotes?.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase()) ?? data.quotes?.[0];
    if (!q) return;

    const priceEl    = meta.el.querySelector<HTMLElement>('[data-price]');
    const changeEl   = meta.el.querySelector<HTMLElement>('[data-change]');
    const updatedEl  = meta.el.querySelector<HTMLElement>('[data-updated]');
    const statEl     = meta.el.querySelector<HTMLElement>('[data-stat="price"]');
    const lineEl     = meta.el.querySelector<SVGPathElement>('[data-spark-line]');
    const areaEl     = meta.el.querySelector<SVGPathElement>('[data-spark-area]');

    const prevText = priceEl?.textContent ?? '';
    const nextText = fmtPrice(q.price);
    if (priceEl && nextText !== prevText) {
      priceEl.textContent = nextText;
      // Detect direction by parsing prior price text — quick & dirty but fine here
      const prevNum = parseFloat(prevText.replace(/[^0-9.\-]/g, ''));
      if (statEl && Number.isFinite(prevNum)) {
        const dirClass = q.price >= prevNum ? '--flash-up' : '--flash-down';
        statEl.classList.remove('--flash-up', '--flash-down');
        // restart animation by forcing reflow
        void statEl.offsetWidth;
        statEl.classList.add(dirClass);
      }
    }
    if (changeEl) {
      changeEl.textContent = fmtPct(q.change);
      changeEl.classList.toggle('--up', q.change >= 0);
      changeEl.classList.toggle('--down', q.change < 0);
    }
    if (updatedEl) updatedEl.textContent = new Date().toLocaleTimeString();

    // Sparkline
    const history = meta.priceHistory ?? [];
    history.push(q.price);
    if (history.length > 40) history.shift();
    meta.priceHistory = history;
    if (lineEl && areaEl) {
      const { line, area } = buildSparkPaths(history);
      lineEl.setAttribute('d', line);
      areaEl.setAttribute('d', area);
      const dirClass = q.change >= 0 ? '--up' : '--down';
      lineEl.classList.remove('--up', '--down'); lineEl.classList.add(dirClass);
      areaEl.classList.remove('--up', '--down'); areaEl.classList.add(dirClass);
    }
  } catch {
    // Best-effort — keep the panel visible with stale data
  }
}

// ─── Dragging ───────────────────────────────────────────────────────────────

function attachDrag(panel: HTMLElement, handle: HTMLElement): void {
  let dragStartX = 0, dragStartY = 0;
  let originX = 0, originY = 0;
  let dragging = false;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    const nextLeft = Math.max(8, Math.min(window.innerWidth - 100, originX + dx));
    const nextTop  = Math.max(8, Math.min(window.innerHeight - 60, originY + dy));
    panel.style.left = `${nextLeft}px`;
    panel.style.top = `${nextTop}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  };
  const onUp = () => {
    dragging = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  handle.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.argus-popout-chrome-btn')) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    const rect = panel.getBoundingClientRect();
    originX = rect.left;
    originY = rect.top;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function openArgusPanel(spec: ArgusPanelSpec): string {
  ensureStyle();
  const root = ensureRoot();

  // Deduplicate — if a panel with the same kind+headline+title is already open,
  // close it first so the new one takes its place (rather than stacking
  // duplicates like the "UA NEWS x3" the user reported).
  const dedupeKey = makeDedupeKey(spec);
  for (const [existingId, meta] of openPanels) {
    if (meta.dedupeKey === dedupeKey) {
      closeArgusPanel(existingId);
      break;
    }
  }

  // Cap the number of simultaneous panels — close the oldest if at limit
  while (openPanels.size >= MAX_PANELS) {
    const oldestId = openPanels.keys().next().value;
    if (oldestId) closeArgusPanel(oldestId);
    else break;
  }

  const id = spec.id ?? genId();
  if (openPanels.has(id)) closeArgusPanel(id);

  const panel = document.createElement('div');
  panel.className = 'argus-popout';
  panel.dataset.argusPanelId = id;
  panel.dataset.kind = spec.kind;
  panel.innerHTML = `
    <div class="argus-popout-chrome">
      <div class="argus-popout-chrome-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>
        <span>${escape(spec.title)}</span>
      </div>
      <div class="argus-popout-chrome-actions">
        <button class="argus-popout-chrome-btn" data-act="min" title="Minimize">_</button>
        <button class="argus-popout-chrome-btn" data-act="max" title="Maximize">⤢</button>
        <button class="argus-popout-chrome-btn danger" data-act="close" title="Close">✕</button>
      </div>
    </div>
    ${spec.headline || spec.subtitle ? `
      <div class="argus-popout-banner">
        ${spec.headline ? `<span class="argus-popout-headline">${escape(spec.headline)}</span>` : ''}
        ${spec.subtitle ? `<span class="argus-popout-subtitle">${escape(spec.subtitle)}</span>` : ''}
      </div>
    ` : ''}
    <div class="argus-popout-body">${renderBody(spec)}</div>
  `;

  // Auto-pack: anchor from the LEFT edge of the viewport, stack panels in
  // rows from left-to-right, then wrap to the next row when we run out of
  // horizontal space. This keeps panels in the part of the screen the user is
  // actually looking at (the map / left half) and away from the chat dock
  // on the right.
  const PANEL_W   = 360;
  const PANEL_H   = 280;
  const GAP       = 12;
  const TOP_PAD   = 88;
  const LEFT_PAD  = 24;
  // Reserve room on the right for the chat dock when it's open.
  const isChatDocked = !!document.querySelector('.goat-overlay.chat-mode');
  const RIGHT_RESERVE = isChatDocked ? 440 : 24;
  const usableW   = window.innerWidth - LEFT_PAD - RIGHT_RESERVE;
  const perRow    = Math.max(1, Math.floor((usableW + GAP) / (PANEL_W + GAP)));

  // Find the first empty slot — don't just rely on count, because panels can
  // be closed individually. Scan slot-by-slot until we find one not occupied.
  const occupied = new Set<string>();
  for (const meta of openPanels.values()) {
    const slot = meta.el.dataset.slot;
    if (slot) occupied.add(slot);
  }
  let slotIdx = 0;
  while (occupied.has(String(slotIdx))) slotIdx++;
  const row = Math.floor(slotIdx / perRow);
  const col = slotIdx % perRow;
  panel.dataset.slot = String(slotIdx);
  panel.style.left  = `${LEFT_PAD + col * (PANEL_W + GAP)}px`;
  panel.style.top   = `${TOP_PAD + row * (PANEL_H + GAP)}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';

  // Wire chrome actions
  const chrome = panel.querySelector<HTMLElement>('.argus-popout-chrome')!;
  // Remember the panel's original position so toggling maximize twice restores it
  let savedPos: { left: string; top: string; right: string; bottom: string } | null = null;
  chrome.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'close') closeArgusPanel(id);
    else if (act === 'min') panel.classList.toggle('--minimized');
    else if (act === 'max') {
      const isMaximized = panel.classList.toggle('--maximized');
      if (isMaximized) {
        // Snapshot current position so we can restore on second click
        savedPos = {
          left: panel.style.left, top: panel.style.top,
          right: panel.style.right, bottom: panel.style.bottom,
        };
        // Hard-clear so CSS class fully owns the position
        panel.style.left = '';
        panel.style.top = '';
        panel.style.right = '';
        panel.style.bottom = '';
      } else if (savedPos) {
        // Restore
        panel.style.left = savedPos.left;
        panel.style.top = savedPos.top;
        panel.style.right = savedPos.right;
        panel.style.bottom = savedPos.bottom;
      }
    }
  });
  attachDrag(panel, chrome);

  root.appendChild(panel);
  const meta: PanelMeta = { el: panel, dedupeKey };
  openPanels.set(id, meta);

  // Seed the price history with the initial quote so the sparkline isn't blank
  if (spec.kind === 'quote' && spec.quote) {
    meta.priceHistory = [spec.quote.price];
  }

  // Live refresh: poll every N ms and animate. Capped at 3s minimum to be
  // gentle on Yahoo and to make ticks visible.
  if (spec.kind === 'quote' && spec.liveRefreshMs && spec.quote?.symbol) {
    const interval = Math.max(3000, spec.liveRefreshMs);
    const sym = spec.quote.symbol;
    meta.liveTimer = setInterval(() => { void refreshLivePanel(id, sym); }, interval);
  }

  // Watchlist: parallel-refresh all symbols on a single interval.
  if (spec.kind === 'watchlist' && spec.watchlist) {
    const interval = Math.max(3000, spec.watchlist.refreshMs ?? 6000);
    const syms = spec.watchlist.symbols;
    // Kick off an immediate refresh so the row prices appear without waiting
    void refreshWatchlistPanel(id, syms);
    meta.liveTimer = setInterval(() => { void refreshWatchlistPanel(id, syms); }, interval);
  }

  // Animate in
  requestAnimationFrame(() => {
    panel.classList.add('--shown', '--flash');
    setTimeout(() => panel.classList.remove('--flash'), 1400);
    // Render initial sparkline (single point shows as flat line — that's fine)
    if (spec.kind === 'quote' && meta.priceHistory && meta.priceHistory.length > 1) {
      const lineEl = panel.querySelector<SVGPathElement>('[data-spark-line]');
      const areaEl = panel.querySelector<SVGPathElement>('[data-spark-area]');
      if (lineEl && areaEl) {
        const { line, area } = buildSparkPaths(meta.priceHistory);
        lineEl.setAttribute('d', line);
        areaEl.setAttribute('d', area);
      }
    }
  });

  return id;
}

/**
 * Refresh an already-open panel's content + banner subtitle in place, without
 * closing/re-opening it. Used by tools that want to show the panel immediately
 * (loading skeleton) and fill it in once the fetch lands — the panel never
 * disappears, only the body swaps.
 *
 * Pass any subset of headline / subtitle / kind-specific data fields. Anything
 * omitted keeps its current value.
 */
export function updateArgusPanel(id: string, patch: Partial<ArgusPanelSpec>): boolean {
  const meta = openPanels.get(id);
  if (!meta) return false;
  const el = meta.el;

  // Banner — only touch if patch provided a new value
  if (patch.headline !== undefined) {
    const h = el.querySelector<HTMLElement>('.argus-popout-headline');
    if (h) h.textContent = patch.headline;
  }
  if (patch.subtitle !== undefined) {
    const s = el.querySelector<HTMLElement>('.argus-popout-subtitle');
    if (s) s.textContent = patch.subtitle;
  }

  // Body — rebuild from a synthetic spec that merges the patch on top of the
  // existing data hint inferred from current DOM. We don't preserve old data
  // across the call; callers pass the kind + new data when they want to swap.
  const body = el.querySelector<HTMLElement>('.argus-popout-body');
  if (body) {
    const kind = (patch.kind ?? (el.dataset.kind as ArgusPanelKind | undefined)) ?? 'text';
    const fullSpec = { kind, title: '', ...patch } as ArgusPanelSpec;
    body.innerHTML = renderBody(fullSpec);

    // Seed price history for fresh quote data so the sparkline starts populating
    if (fullSpec.kind === 'quote' && fullSpec.quote && !patch.loading) {
      if (!meta.priceHistory) meta.priceHistory = [];
      meta.priceHistory.push(fullSpec.quote.price);
    }

    // Highlight-on-update so the user notices the swap
    el.classList.remove('--flash');
    void el.offsetWidth;
    el.classList.add('--flash');
    setTimeout(() => el.classList.remove('--flash'), 1200);

    // Re-arm live refresh polling if the update supplied liveRefreshMs +
    // a quote symbol. Cancel any prior timer first so we don't double-poll.
    if (fullSpec.kind === 'quote' && fullSpec.liveRefreshMs && fullSpec.quote?.symbol) {
      if (meta.liveTimer) clearInterval(meta.liveTimer);
      const sym = fullSpec.quote.symbol;
      const interval = Math.max(3000, fullSpec.liveRefreshMs);
      meta.liveTimer = setInterval(() => { void refreshLivePanel(id, sym); }, interval);
    } else if (fullSpec.kind === 'watchlist' && fullSpec.watchlist?.symbols.length) {
      if (meta.liveTimer) clearInterval(meta.liveTimer);
      const syms = fullSpec.watchlist.symbols;
      const interval = Math.max(3000, fullSpec.watchlist.refreshMs ?? 6000);
      meta.liveTimer = setInterval(() => { void refreshWatchlistPanel(id, syms); }, interval);
    }
  }
  return true;
}

export function closeArgusPanel(id: string): boolean {
  const meta = openPanels.get(id);
  if (!meta) return false;
  if (meta.liveTimer) clearInterval(meta.liveTimer);
  meta.el.classList.remove('--shown');
  setTimeout(() => meta.el.remove(), 250);
  openPanels.delete(id);
  return true;
}

export function closeAllArgusPanels(): number {
  let n = 0;
  for (const id of [...openPanels.keys()]) {
    if (closeArgusPanel(id)) n++;
  }
  return n;
}

/** Expand the most-recent floating panel (or one by id) to near full-screen. */
export function maximizeArgusPanel(id?: string): boolean {
  const targetId = id ?? [...openPanels.keys()].pop();
  if (!targetId) return false;
  const meta = openPanels.get(targetId);
  if (!meta) return false;
  if (!meta.el.classList.contains('--maximized')) {
    // Clear inline positioning so the .--maximized class can fully take over
    meta.el.style.left = '';
    meta.el.style.top = '';
    meta.el.style.right = '';
    meta.el.style.bottom = '';
    meta.el.classList.add('--maximized');
  }
  return true;
}

/** Collapse a maximized panel back to its floating size. */
export function restoreArgusPanel(id?: string): boolean {
  const targetId = id ?? [...openPanels.keys()].pop();
  if (!targetId) return false;
  const meta = openPanels.get(targetId);
  if (!meta) return false;
  meta.el.classList.remove('--maximized');
  return true;
}

/** Get the id of the most recently opened panel — useful for tools that say "the panel". */
export function getLatestArgusPanelId(): string | null {
  const ids = [...openPanels.keys()];
  return ids.length > 0 ? ids[ids.length - 1]! : null;
}
