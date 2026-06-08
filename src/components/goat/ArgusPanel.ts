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

export type ArgusPanelKind = 'quote' | 'news' | 'brief' | 'kv' | 'text' | 'panel-confirm';

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
}

// ─── State ──────────────────────────────────────────────────────────────────

interface PanelMeta {
  el: HTMLElement;
  liveTimer?: ReturnType<typeof setInterval>;
  priceHistory?: number[]; // for sparkline
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
  switch (spec.kind) {
    case 'quote':         return renderQuote(spec.quote, !!spec.liveRefreshMs);
    case 'news':          return renderNews(spec.news);
    case 'brief':         return renderBrief(spec.brief);
    case 'kv':            return renderKv(spec.kv);
    case 'text':          return `<div>${escape(spec.text ?? '')}</div>`;
    case 'panel-confirm': return renderConfirm(spec.confirm);
  }
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

  // Column-stack on the right edge: each panel sits below the previous one
  // at the same x, so they don't drift diagonally and they don't cover the
  // avatar. If we exceed viewport height, wrap to a second column further left.
  //
  // When ARGUS is docked as a chat widget (bottom-right), shift our anchor
  // further left so panels don't sit behind the dock. The dock is ~400 px
  // wide with a 20 px gutter; 440 px keeps panels clear of it.
  const isChatDocked = !!document.querySelector('.goat-overlay.chat-mode');
  const DOCK_RESERVE = isChatDocked ? 440 : 24;
  const COL_X       = DOCK_RESERVE;
  const FIRST_Y     = 88;        // distance from top
  const ROW_GAP     = 12;
  const APPROX_H    = 280;       // assumed panel height; layout adjusts via CSS
  const colHeight   = window.innerHeight - FIRST_Y - 24;
  const perCol      = Math.max(1, Math.floor(colHeight / (APPROX_H + ROW_GAP)));
  const indexInUI   = openPanels.size;
  const col         = Math.floor(indexInUI / perCol);
  const row         = indexInUI % perCol;
  panel.style.top   = `${FIRST_Y + row * (APPROX_H + ROW_GAP)}px`;
  panel.style.right = `${COL_X + col * 380}px`; // 380 = approx panel width + gap

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
