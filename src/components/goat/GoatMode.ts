/**
 * GOAT mode — Jarvis-style voice AI assistant overlay for AlsaGlobal.
 *
 * Orchestrates Avatar3D, VoiceSession (Gemini Live), LipSync, Transcription,
 * Waveform, and AgentTools. Each of those modules is lazy-loaded so we don't
 * pay the Three.js + audio-stack cost until the user actually activates GOAT.
 */

import type { AppContext } from '@/app/app-context';
import type { AvatarHandle } from './Avatar3D';
import type { VoiceSessionHandle } from './VoiceSession';
import type { LipSyncHandle } from './LipSync';
import type { TranscriptionHandle } from './Transcription';
import type { WaveformHandle } from './Waveform';

const GOAT_NAME_KEY = 'alsaglobal-goat-name';
const GOAT_VOICE_KEY = 'alsaglobal-goat-voice';
const DEFAULT_NAME = 'ARGUS';
// Gemini Live voices: Aoede (warm female), Kore (clear female), Leda (female),
// Zephyr (female), Puck/Charon/Fenrir/Orus (male). Default to a female voice.
const DEFAULT_VOICE = 'Aoede';

let activeOverlay: GoatOverlay | null = null;

export function getGoatName(): string {
  try {
    return localStorage.getItem(GOAT_NAME_KEY) || DEFAULT_NAME;
  } catch {
    return DEFAULT_NAME;
  }
}

export function setGoatName(name: string): void {
  try { localStorage.setItem(GOAT_NAME_KEY, name.trim() || DEFAULT_NAME); } catch { /* ignore */ }
}

export function getGoatVoice(): string {
  try {
    const stored = localStorage.getItem(GOAT_VOICE_KEY);
    // Auto-upgrade: the previous hard-coded default was the male voice 'Charon'.
    // Anyone who never explicitly changed it should now get the new female default.
    if (!stored || stored === 'Charon') return DEFAULT_VOICE;
    return stored;
  } catch {
    return DEFAULT_VOICE;
  }
}

export function setGoatVoice(v: string): void {
  try { localStorage.setItem(GOAT_VOICE_KEY, v); } catch { /* ignore */ }
}

export function isGoatActive(): boolean {
  return !!activeOverlay;
}

export function toggleGoatMode(ctx: AppContext): void {
  if (activeOverlay) {
    closeGoatMode();
  } else {
    openGoatMode(ctx);
  }
}

export function openGoatMode(ctx: AppContext): void {
  if (activeOverlay) return;
  activeOverlay = new GoatOverlay(ctx);
  activeOverlay.open();
  document.getElementById('goatModeBtn')?.classList.add('active');
}

export function closeGoatMode(): void {
  if (!activeOverlay) return;
  activeOverlay.close();
  activeOverlay = null;
  document.getElementById('goatModeBtn')?.classList.remove('active');
}

type SessionState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error' | 'closed';

class GoatOverlay {
  private ctx: AppContext;
  private root: HTMLElement | null = null;
  private avatar: AvatarHandle | null = null;
  private session: VoiceSessionHandle | null = null;
  private lipSync: LipSyncHandle | null = null;
  private transcription: TranscriptionHandle | null = null;
  private waveform: WaveformHandle | null = null;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;
  private kbdHandler: ((e: KeyboardEvent) => void) | null = null;
  private chatModeHandler: (() => void) | null = null;
  private muted = false;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  async open(): Promise<void> {
    this.buildShell();
    this.setStatus('connecting', 'Connecting...');

    // Pre-flight: confirm the proxy is alive and learn which provider is wired up
    // (gemini | openai). Surface 503 / 404 as readable reasons instead of letting
    // the user hit a generic 1006 close after mic/audio contexts are open.
    const reachable = await this.probeProxy();
    if (!reachable.ok) {
      this.setStatus('error', reachable.reason);
      return;
    }
    const provider = reachable.provider;

    try {
      const [avatarMod, voiceMod, lipsyncMod, agentMod, transMod, waveMod] = await Promise.all([
        import('./Avatar3D'),
        import('./VoiceSession'),
        import('./LipSync'),
        import('./AgentTools'),
        import('./Transcription'),
        import('./Waveform'),
      ]);

      const canvasEl = this.root!.querySelector<HTMLCanvasElement>('.goat-avatar-canvas')!;
      const transEl = this.root!.querySelector<HTMLDivElement>('.goat-transcription')!;
      const waveUserEl = this.root!.querySelector<HTMLCanvasElement>('.goat-waveform-user')!;
      const waveAiEl = this.root!.querySelector<HTMLCanvasElement>('.goat-waveform-ai')!;

      this.avatar = await avatarMod.createAvatar3D(canvasEl);
      this.transcription = transMod.createTranscription(transEl);

      const tools = agentMod.createAgentTools(this.ctx);

      this.session = await voiceMod.createVoiceSession({
        name: getGoatName(),
        voice: getGoatVoice(),
        provider,
        tools: tools.schema,
        onState: (s) => this.setStatus(s, this.statusLabel(s)),
        onUserTranscript: (text, opts) => this.transcription?.append('user', text, { interim: opts?.isInterim }),
        // ARGUS's speech is delivered via voice. Don't echo the same text into
        // the transcript box — it just clutters the UI with stuff the user
        // already heard. Only the user's side appears in the transcript.
        onModelTranscript: () => {},
        onToolCall: async (name, args) => {
          this.setStatus('thinking', `Calling ${name}...`);
          return tools.execute(name, args);
        },
        onUserAudioNode: (node) => {
          this.waveform = waveMod.attachWaveform(waveUserEl, waveAiEl, node, null);
        },
        onAiAudioNode: (node) => {
          this.lipSync = lipsyncMod.startLipSync(node, this.avatar!);
          // attach AI side to waveform
          if (this.waveform) {
            this.waveform.stop();
          }
          this.waveform = waveMod.attachWaveform(waveUserEl, waveAiEl, null, node);
        },
      });

      this.attachControls();
      this.startTicker();
    } catch (err) {
      console.error('[GOAT] failed to open:', err);
      this.setStatus('error', `Failed to start: ${(err as Error).message}`);
    }
  }

  // ─── Live ticker tape ─────────────────────────────────────────────────────
  private tickerTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly TICKER_SYMBOLS = [
    '^GSPC', '^IXIC', '^DJI', '^VIX',
    'BTC-USD', 'ETH-USD', 'SOL-USD',
    'GC=F', 'CL=F', 'EURUSD=X', 'USDJPY=X', 'GBPUSD=X',
    'AAPL', 'TSLA', 'NVDA', 'MSFT', 'GOOGL', 'META',
  ];
  private startTicker(): void {
    const update = async () => {
      const track = this.root?.querySelector<HTMLElement>('#goatTickerTrack');
      if (!track) return;
      try {
        const url = `/api/market/v1/list-market-quotes?symbols=${GoatOverlay.TICKER_SYMBOLS.join(',')}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json() as { quotes?: Array<{ symbol: string; price: number; change: number }> };
        const quotes = data.quotes ?? [];
        if (quotes.length === 0) return;
        // Duplicate the items so the marquee loop is seamless
        const html = [...quotes, ...quotes].map((q) => {
          const cls = q.change >= 0 ? 'up' : 'down';
          const arrow = q.change >= 0 ? '▲' : '▼';
          return `<span class="goat-ticker-item ${cls}">
            <span class="goat-ticker-sym">${escape(q.symbol)}</span>
            <span class="goat-ticker-px">${q.price.toFixed(2)}</span>
            <span class="goat-ticker-chg">${arrow} ${Math.abs(q.change).toFixed(2)}%</span>
          </span>`;
        }).join('');
        track.innerHTML = html;
      } catch { /* ignore — keep last frame */ }
    };
    void update();
    this.tickerTimer = setInterval(() => { void update(); }, 30_000);
  }

  private buildShell(): void {
    const name = getGoatName();
    this.root = document.createElement('div');
    this.root.className = 'goat-overlay';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', `${name} voice assistant`);
    this.root.innerHTML = `
      <div class="goat-overlay-bg"></div>
      <div class="goat-overlay-shell">
        <div class="goat-overlay-topbar">
          <div class="goat-overlay-title">
            <span class="goat-overlay-pulse"></span>
            <span class="goat-overlay-name">${escape(name)}</span>
            <span class="goat-overlay-tag">VOICE ASSISTANT · LIVE</span>
          </div>
          <div class="goat-overlay-status" id="goatStatus" aria-live="polite">Booting...</div>
          <div class="goat-overlay-controls">
            <button class="goat-exit-btn" id="goatChatModeBtn" title="Switch between chat dock and full-screen mode">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
              <span id="goatChatModeLabel">Full mode</span>
            </button>
            <button class="goat-exit-btn" id="goatMinimizeBtn" title="Minimize to corner (voice keeps running)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>
              <span>Minimize</span>
            </button>
            <button class="goat-exit-btn" id="goatExitBtn" title="Back to dashboard (Esc)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              <span>Dashboard</span>
            </button>
          </div>
        </div>

        <div class="goat-overlay-main goat-overlay-main--solo">
          <div class="goat-stage-col">
            <div class="goat-avatar-stage">
              <canvas class="goat-avatar-canvas"></canvas>
              <div class="goat-avatar-glow"></div>
            </div>

            <div class="goat-waveform-bar">
              <div class="goat-waveform-side">
                <canvas class="goat-waveform-user" width="320" height="38" aria-label="Your microphone level"></canvas>
              </div>
              <div class="goat-waveform-divider"></div>
              <div class="goat-waveform-side">
                <canvas class="goat-waveform-ai" width="320" height="38" aria-label="${escape(name)} voice level"></canvas>
              </div>
            </div>

          </div>
        </div>

        <div class="goat-ticker" id="goatTicker" aria-label="Live market ticker">
          <div class="goat-ticker-track" id="goatTickerTrack">
            <span class="goat-ticker-loading">Loading live tape…</span>
          </div>
        </div>

        <div class="goat-transcription-wrap">
          <div class="goat-transcription" id="goatTranscription" aria-live="polite"></div>
        </div>

        <div class="goat-input-bar">
          <button class="goat-input-mic" id="goatMicBtn" title="Mute microphone" aria-pressed="false" aria-label="Mute microphone">
            <svg class="ico-on" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
            <svg class="ico-off" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7 7 0 0 0 19 12v-1"/><path d="M5 11v1a7 7 0 0 0 11.31 5.53"/><path d="M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
          </button>
          <input type="text" class="goat-input-field" id="goatTextInput"
                 placeholder="Type a message, or talk to ${escape(name)}…"
                 autocomplete="off" spellcheck="false" />
          <button class="goat-input-send" id="goatTextSendBtn" title="Send" aria-label="Send">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(this.root);
    // Open as a chatbot widget by default so the dashboard stays visible from
    // the first frame. The user can click "Full mode" in the topbar if they
    // want the immersive overlay. This is the single biggest UX fix: when
    // ARGUS opens, you can see the map react to her actions in real time.
    this.root.classList.add('chat-mode');
    this.chatMode = true;
    requestAnimationFrame(() => this.root!.classList.add('visible'));
  }

  private minimized = false;
  private chatMode = false;
  private toggleMinimized(force?: boolean): void {
    if (!this.root) return;
    this.minimized = force === undefined ? !this.minimized : force;
    this.root.classList.toggle('minimized', this.minimized);
    // Exiting minimized never auto-enters chat mode
    if (!this.minimized) this.root.classList.toggle('chat-mode', this.chatMode);
  }
  private toggleChatMode(force?: boolean): void {
    if (!this.root) return;
    this.chatMode = force === undefined ? !this.chatMode : force;
    this.root.classList.toggle('chat-mode', this.chatMode && !this.minimized);
    const label = this.root.querySelector('#goatChatModeLabel');
    if (label) label.textContent = this.chatMode ? 'Full mode' : 'Chat mode';
  }

  private attachControls(): void {
    this.root!.querySelector<HTMLButtonElement>('#goatExitBtn')?.addEventListener('click', () => {
      closeGoatMode();
    });
    this.root!.querySelector<HTMLButtonElement>('#goatMinimizeBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMinimized(true);
    });
    this.root!.querySelector<HTMLButtonElement>('#goatChatModeBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleChatMode();
    });
    // When minimized, clicking anywhere on the bubble restores the full overlay.
    this.root!.addEventListener('click', (e) => {
      if (!this.minimized) return;
      // Ignore clicks inside the input bar / mute button while minimized (none
      // are visible, but defensive). Restore on any avatar click.
      const target = e.target as HTMLElement;
      if (target.closest('.goat-avatar-stage, .argus-avatar')) {
        this.toggleMinimized(false);
      }
    });
    this.root!.querySelector<HTMLButtonElement>('#goatMicBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.muted = !this.muted;
      this.session?.setMuted(this.muted);
      const btn = e.currentTarget as HTMLButtonElement;
      btn.classList.toggle('muted', this.muted);
      btn.setAttribute('aria-pressed', String(this.muted));
      btn.setAttribute('title', this.muted ? 'Unmute microphone' : 'Mute microphone');
      btn.setAttribute('aria-label', this.muted ? 'Unmute microphone' : 'Mute microphone');
    });

    // Text input bar — typed messages go to Gemini as a text turn.
    const textInput = this.root!.querySelector<HTMLInputElement>('#goatTextInput');
    const sendBtn   = this.root!.querySelector<HTMLButtonElement>('#goatTextSendBtn');
    const sendTyped = () => {
      if (!textInput) return;
      const text = textInput.value.trim();
      if (!text || !this.session) return;
      this.session.sendText(text);
      textInput.value = '';
    };
    sendBtn?.addEventListener('click', sendTyped);
    textInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendTyped();
      }
    });

    // Click the avatar to "interrupt" ARGUS — cancels in-flight audio playback
    // by signaling a turn-cancel. Useful when she's narrating something long.
    const avatarStage = this.root!.querySelector<HTMLElement>('.goat-avatar-stage');
    avatarStage?.addEventListener('click', () => {
      // The actual cancel is done via the WebSocket; for now just visual cue
      avatarStage.classList.remove('--interrupted');
      void avatarStage.offsetWidth;
      avatarStage.classList.add('--interrupted');
    });

    // Auto-dock listener — tools dispatch this when they touch the dashboard
    // so the user can see the result. Skip if user has already moved to
    // chat/minimized themselves.
    this.chatModeHandler = () => {
      if (this.chatMode || this.minimized) return;
      this.toggleChatMode(true);
    };
    document.addEventListener('argus:request-chat-mode', this.chatModeHandler);

    // Keyboard shortcuts. Esc → minimize-to-corner (or close if already minimized).
    // Ctrl+/ or Cmd+/ → focus the text input.
    this.kbdHandler = (e: KeyboardEvent) => {
      // Don't steal keystrokes while typing
      const target = e.target as HTMLElement | null;
      const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (e.key === 'Escape' && !inField) {
        if (this.minimized) closeGoatMode();
        else this.toggleMinimized(true);
      } else if (e.key === '/' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        textInput?.focus();
      }
    };
    document.addEventListener('keydown', this.kbdHandler);
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeGoatMode();
    };
    document.addEventListener('keydown', this.escHandler);
  }

  private setStatus(state: SessionState, label: string): void {
    const el = this.root?.querySelector<HTMLDivElement>('#goatStatus');
    if (el) {
      el.textContent = label;
      el.dataset.state = state;
    }
    this.avatar?.setMood(
      state === 'speaking' ? 'speaking' :
      state === 'listening' ? 'listening' :
      state === 'thinking' ? 'thinking' :
      'idle',
    );
  }

  private statusLabel(s: SessionState): string {
    switch (s) {
      case 'connecting': return 'Connecting...';
      case 'listening':  return 'Listening';
      case 'thinking':   return 'Thinking...';
      case 'speaking':   return 'Speaking';
      case 'error':      return 'Error';
      case 'closed':     return 'Disconnected';
    }
  }

  /**
   * Confirm an API key is wired up server-side before opening the mic. The
   * proxy also tells us which realtime provider it's using so the client can
   * speak the right wire protocol. 503 = key missing; 404 = plugin not
   * registered (restart dev server).
   */
  private async probeProxy(): Promise<
    { ok: true; provider: 'gemini' | 'openai' } | { ok: false; reason: string }
  > {
    try {
      const res = await fetch('/api/goat/key', { method: 'GET' });
      if (res.status === 404) {
        return { ok: false, reason: 'Proxy not registered. Restart dev server (Ctrl+C, then npm run dev).' };
      }
      if (res.status === 503) {
        return { ok: false, reason: 'Realtime API key not set. Add GEMINI_API_KEY or OPENAI_API_KEY to .env and restart.' };
      }
      if (!res.ok) {
        return { ok: false, reason: `Proxy returned HTTP ${res.status}` };
      }
      const body = await res.json().catch(() => ({})) as { key?: string; provider?: 'gemini' | 'openai' };
      if (!body.key) return { ok: false, reason: 'Proxy returned no key' };
      const provider = body.provider === 'openai' ? 'openai' : 'gemini';
      return { ok: true, provider };
    } catch (err) {
      return { ok: false, reason: `Server unreachable: ${(err as Error).message}` };
    }
  }

  close(): void {
    if (this.escHandler) {
      document.removeEventListener('keydown', this.escHandler);
      this.escHandler = null;
    }
    if (this.kbdHandler) {
      document.removeEventListener('keydown', this.kbdHandler);
      this.kbdHandler = null;
    }
    if (this.chatModeHandler) {
      document.removeEventListener('argus:request-chat-mode', this.chatModeHandler);
      this.chatModeHandler = null;
    }
    if (this.tickerTimer) { clearInterval(this.tickerTimer); this.tickerTimer = null; }
    this.lipSync?.stop();
    this.waveform?.stop();
    this.session?.close();
    this.avatar?.destroy();
    this.transcription?.clear();
    // Tear down any floating ArgusPanels that were spawned by tool calls
    void import('./ArgusPanel').then((m) => m.closeAllArgusPanels()).catch(() => {});
    this.root?.classList.remove('visible');
    const root = this.root;
    setTimeout(() => root?.remove(), 220);
    this.root = null;
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
