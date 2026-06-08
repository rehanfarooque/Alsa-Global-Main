/**
 * VoiceSession — Gemini Live WebSocket bridge for ARGUS.
 *
 *  - Captures mic PCM (16 kHz mono) via Web Audio
 *  - Streams base64 PCM to the dev proxy at /api/goat/live, which fans out
 *    to wss://generativelanguage.googleapis.com (BidiGenerateContent)
 *  - Receives 24 kHz PCM audio and plays it via WebAudio so we can tap
 *    AnalyserNodes for the waveform bar + lip-sync
 *  - Handles inbound `toolCall` frames, dispatches to the caller's handler,
 *    sends `toolResponse` back to the model
 *
 * The Live API model and voice are the only knobs you tune for latency vs.
 * quality. Both are constants at the top — change here only.
 */

import type { ToolDefinition } from './AgentTools';

// ─── Tuning knobs — change here only ─────────────────────────────────────────
// Confirmed working against the GEMINI_API_KEY in .env on 2026-06-07:
//   gemini-3.1-flash-live-preview          — 442ms handshake, fastest
//   gemini-2.5-flash-native-audio-latest   — 580ms, stable channel
const LIVE_MODEL = 'gemini-3.1-flash-live-preview';

// 2048 samples @ 16 kHz = 128 ms of audio per upload chunk. Smaller = lower
// latency, more network frames. 1024 also works on modern Chrome.
const MIC_BUFFER_SIZE = 2048;
const MIC_SAMPLE_RATE = 16000;
const AI_SAMPLE_RATE = 24000;
// ──────────────────────────────────────────────────────────────────────────────

export type VoiceState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error' | 'closed';

export interface VoiceSessionOptions {
  name: string;
  voice: string;
  tools: ToolDefinition[];
  onState: (state: VoiceState, info?: string) => void;
  /** `isInterim` = caption is mid-utterance (Web Speech API live). Replace prior interim line, do not coalesce. */
  onUserTranscript: (text: string, opts?: { isInterim?: boolean }) => void;
  onModelTranscript: (text: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  onUserAudioNode?: (node: AudioNode) => void;
  onAiAudioNode?: (node: AudioNode) => void;
}

export interface VoiceSessionHandle {
  close(): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  /** Send a text turn (typed message) to Gemini. Triggers a normal voice response. */
  sendText(text: string): void;
}

export async function createVoiceSession(options: VoiceSessionOptions): Promise<VoiceSessionHandle> {
  console.log(`[VoiceSession] Initializing Live API (model=${LIVE_MODEL})`);

  // ── 1. Mic capture ─────────────────────────────────────────────────────────
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: MIC_SAMPLE_RATE,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const ACtor = window.AudioContext
    || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const micCtx = new ACtor({ sampleRate: MIC_SAMPLE_RATE });
  if (micCtx.state === 'suspended') await micCtx.resume().catch(() => {});

  const micSource = micCtx.createMediaStreamSource(stream);
  const userAnalyser = micCtx.createAnalyser();
  userAnalyser.fftSize = 512;
  micSource.connect(userAnalyser);
  options.onUserAudioNode?.(userAnalyser);

  // ScriptProcessor is deprecated but universal. AudioWorklet would be the
  // modern option; it needs a separate file shipped to the worker.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const processor = (micCtx as unknown as {
    createScriptProcessor: (size: number, ins: number, outs: number) => ScriptProcessorNode;
  }).createScriptProcessor(MIC_BUFFER_SIZE, 1, 1);
  micSource.connect(processor);

  // Some browsers won't fire onaudioprocess unless the node is connected to
  // destination. Route through a silent gain so the user doesn't echo.
  const muteGain = micCtx.createGain();
  muteGain.gain.value = 0;
  processor.connect(muteGain);
  muteGain.connect(micCtx.destination);

  // ── 2a. Web Speech API live captions (started early so they show even
  //         while the WebSocket is still connecting / erroring). Browser STT
  //         is independent of getUserMedia — Chrome ships its own internal
  //         capture for SpeechRecognition.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  let recognition: { stop(): void; abort(): void; start?(): void } | null = null;
  let webSpeechActiveEarly = false;
  if (SR) {
    try {
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = 'en-US';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onresult = (e: any) => {
        if (closed || muted) return;
        let interim = '';
        let final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const t = r[0]?.transcript ?? '';
          if (r.isFinal) final += t;
          else interim += t;
        }
        if (interim.trim()) options.onUserTranscript(interim.trim(), { isInterim: true });
        if (final.trim())   options.onUserTranscript(final.trim());
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onerror = (e: any) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        console.warn('[VoiceSession] Web Speech error:', e.error);
      };
      rec.onend = () => {
        if (!closed) { try { rec.start(); } catch { /* already started */ } }
      };
      rec.start();
      webSpeechActiveEarly = true;
      recognition = rec;
      console.log('[VoiceSession] Web Speech API live captions running (early)');
    } catch (err) {
      console.warn('[VoiceSession] Web Speech setup failed, falling back to Gemini ASR:', (err as Error).message);
    }
  } else {
    console.log('[VoiceSession] Web Speech API unavailable — using Gemini server-side transcription');
  }

  // ── 2b. AI playback ─────────────────────────────────────────────────────────
  const playCtx = new ACtor({ sampleRate: AI_SAMPLE_RATE });
  if (playCtx.state === 'suspended') await playCtx.resume().catch(() => {});
  const aiGain = playCtx.createGain();
  aiGain.gain.value = 1.0;
  const aiAnalyser = playCtx.createAnalyser();
  aiAnalyser.fftSize = 2048;
  aiGain.connect(aiAnalyser);
  aiGain.connect(playCtx.destination);
  options.onAiAudioNode?.(aiAnalyser);

  // ── 3. WebSocket to dev proxy ──────────────────────────────────────────────
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProto}//${window.location.host}/api/goat/live`;
  console.log('[VoiceSession] Connecting WebSocket:', wsUrl);
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  let muted = false;
  let closed = false;
  let setupAcked = false;
  let currentState: VoiceState = 'connecting';
  let audioChunksReceived = 0;
  let audioChunksSent = 0;
  const webSpeechActive = webSpeechActiveEarly; // True while a SpeechRecognition session is running

  const setState = (s: VoiceState, info?: string) => {
    if (closed) return;
    if (currentState !== s) {
      currentState = s;
      console.log(`[VoiceSession] state -> ${s}${info ? ` (${info})` : ''}`);
    }
    options.onState(s, info);
  };
  setState('connecting');

  // Watchdog: if setupComplete doesn't arrive within 12s after WS open,
  // surface a clear error rather than letting the status pill hang on CONNECTING.
  let setupWatchdog: ReturnType<typeof setTimeout> | null = null;
  ws.addEventListener('open', () => {
    setupWatchdog = setTimeout(() => {
      if (!setupAcked && !closed) {
        console.warn('[VoiceSession] setupComplete not received within 12s');
        setState('error', 'No setupComplete from Gemini. Check dev server console for upstream errors.');
      }
    }, 12_000);
    console.log('[VoiceSession] WebSocket open — sending setup');
    const setupMsg = {
      setup: {
        model: `models/${LIVE_MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: options.voice },
            },
          },
        },
        systemInstruction: { parts: [{ text: buildSystemPrompt(options.name) }] },
        tools: options.tools.length > 0 ? [{ functionDeclarations: options.tools }] : undefined,
        // Have the server transcribe both sides so we can render text alongside audio
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    };
    try {
      ws.send(JSON.stringify(setupMsg));
    } catch (err) {
      console.error('[VoiceSession] Failed to send setup:', err);
      setState('error', 'Setup send failed');
    }
  });

  ws.addEventListener('error', () => {
    setState('error', 'WebSocket error — check dev server console');
  });

  ws.addEventListener('close', (e) => {
    console.log(`[VoiceSession] WebSocket closed: code=${e.code} reason=${e.reason || 'none'}`);
    if (closed) return;
    const reason = wsCloseReason(e.code, e.reason);
    setState(setupAcked ? 'closed' : 'error', reason);
  });

  // ── 4. AI audio playback queue ─────────────────────────────────────────────
  let nextPlayTime = 0;
  let lastSpeakingAt = 0;

  const playPcmChunk = (pcm: Int16Array) => {
    const float = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) float[i] = pcm[i]! / 32768;
    const buf = playCtx.createBuffer(1, float.length, AI_SAMPLE_RATE);
    buf.getChannelData(0).set(float);
    const src = playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(aiGain);
    const now = playCtx.currentTime;
    const startAt = Math.max(now, nextPlayTime);
    src.start(startAt);
    nextPlayTime = startAt + buf.duration;
    lastSpeakingAt = performance.now();
    setState('speaking');
    src.onended = () => {
      // Return to listening only after a brief silence to avoid flicker
      // between consecutive audio frames within the same utterance.
      setTimeout(() => {
        if (!closed && performance.now() - lastSpeakingAt > 250) {
          setState('listening');
        }
      }, 280);
    };
  };

  // ── 5. Inbound message dispatch ────────────────────────────────────────────
  ws.addEventListener('message', async (evt) => {
    try {
      const text = typeof evt.data === 'string'
        ? evt.data
        : new TextDecoder().decode(evt.data as ArrayBuffer);
      const msg = JSON.parse(text);

      // Diagnostic messages from the dev proxy itself (not from Gemini).
      // The plugin sends these when it can't reach upstream so we can show
      // a real reason instead of letting the client hang on CONNECTING.
      if (msg._proxyError) {
        const pe = msg._proxyError as { reason: string; message: string; code?: number };
        console.warn(`[VoiceSession] proxy error: ${pe.reason} — ${pe.message}`);
        setState('error', pe.message || pe.reason);
        return;
      }

      if (msg.setupComplete) {
        setupAcked = true;
        if (setupWatchdog) { clearTimeout(setupWatchdog); setupWatchdog = null; }
        console.log('[VoiceSession] setupComplete — Gemini ready');
        setState('listening', 'Ready');
        return;
      }

      if (msg.serverContent) {
        const sc = msg.serverContent;
        const parts = sc.modelTurn?.parts ?? [];
        for (const part of parts) {
          if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
            audioChunksReceived++;
            const b64 = part.inlineData.data as string;
            const bytes = base64ToBytes(b64);
            const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
            playPcmChunk(pcm);
          }
          if (part.text) options.onModelTranscript(part.text);
        }
        // Gemini's server-side ASR is the FALLBACK for user transcripts when
        // Web Speech API isn't available (Safari, locked-down Chromium, etc.).
        // When Web Speech is running, it has already committed the line, so
        // these arrive as no-ops on the same content.
        if (sc.inputTranscription?.text && !webSpeechActive) {
          options.onUserTranscript(sc.inputTranscription.text);
        }
        if (sc.outputTranscription?.text) options.onModelTranscript(sc.outputTranscription.text);
        return;
      }

      if (msg.toolCall) {
        setState('thinking', 'Calling tool');
        const calls = msg.toolCall.functionCalls ?? [];
        console.log(`[VoiceSession] tool call: ${calls.map((c: { name: string }) => c.name).join(', ')}`);
        const responses: Array<{ id: string; name: string; response: { result: unknown } }> = [];
        for (const call of calls) {
          try {
            const result = await options.onToolCall(call.name, call.args ?? {});
            responses.push({ id: call.id, name: call.name, response: { result } });
          } catch (err) {
            responses.push({
              id: call.id,
              name: call.name,
              response: { result: { error: (err as Error).message } },
            });
          }
        }
        ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
        return;
      }

      console.log('[VoiceSession] unhandled message keys:', Object.keys(msg));
    } catch (err) {
      console.warn('[VoiceSession] message parse error:', (err as Error).message);
    }
  });

  // ── 6. Mic → upstream ──────────────────────────────────────────────────────
  processor.onaudioprocess = (e) => {
    if (muted || !setupAcked || ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]!));
      pcm16[i] = s < 0 ? s * 32768 : s * 32767;
    }
    const b64 = bytesToBase64(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength));
    // Gemini Live deprecated `realtimeInput.mediaChunks` in favor of typed
    // top-level fields (audio | video | text). Using the new shape — the old
    // one closes the upstream with code 1007.
    const payload = {
      realtimeInput: {
        audio: { mimeType: 'audio/pcm;rate=16000', data: b64 },
      },
    };
    try {
      ws.send(JSON.stringify(payload));
      audioChunksSent++;
      if (audioChunksSent % 50 === 0) {
        console.log(`[VoiceSession] mic chunks sent: ${audioChunksSent}, audio received: ${audioChunksReceived}`);
      }
    } catch (err) {
      console.warn('[VoiceSession] send failed:', (err as Error).message);
    }
  };

  return {
    close() {
      if (closed) return;
      closed = true;
      console.log('[VoiceSession] Closing');
      if (setupWatchdog) { clearTimeout(setupWatchdog); setupWatchdog = null; }
      try { recognition?.abort(); } catch { /* ignore */ }
      try { processor.disconnect(); } catch { /* ignore */ }
      try { micSource.disconnect(); } catch { /* ignore */ }
      try { muteGain.disconnect(); } catch { /* ignore */ }
      try { aiGain.disconnect(); } catch { /* ignore */ }
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
      void micCtx.close().catch(() => {});
      void playCtx.close().catch(() => {});
      setState('closed');
    },
    setMuted(m) {
      muted = m;
      console.log(`[VoiceSession] muted=${m}`);
      // Stop captions while muted so we don't show captions for room noise
      if (m) { try { recognition?.stop(); } catch { /* ignore */ } }
      else if (recognition && !closed) { try { (recognition as { start?: () => void }).start?.(); } catch { /* ignore */ } }
    },
    isMuted() { return muted; },
    sendText(text) {
      if (closed || !setupAcked || ws.readyState !== WebSocket.OPEN) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      // Surface the user's typed text in the transcript so they see it in context
      options.onUserTranscript(trimmed);
      // Gemini Live accepts text turns via clientContent. turnComplete tells the
      // model the user is done, prompting a response.
      const payload = {
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: trimmed }] }],
          turnComplete: true,
        },
      };
      try { ws.send(JSON.stringify(payload)); } catch (err) {
        console.warn('[VoiceSession] text send failed:', (err as Error).message);
      }
    },
  };
}

// ─── System prompt — tuned for proactive tool use ────────────────────────────
function buildSystemPrompt(name: string): string {
  return `You are ${name} — a friendly, capable voice assistant for the AlsaGlobal World Monitor dashboard. You help the user understand what's happening in the world, in the markets, and on their screen.

VOICE & TONE
- Warm, natural, conversational — not formal, not robotic. Speak like a knowledgeable friend.
- Brief and clear by default. One or two short sentences. Expand only when the user asks for detail.
- Never say "I'll look that up" or "let me check" — just do it. Action first, then answer.
- Don't read URLs, code, JSON, or markdown aloud. Speak in clean spoken English.

USE TOOLS FOR EVERYTHING DATA-RELATED. Never invent numbers or headlines.
Examples (call the tool, then narrate the result):
  user: "what's bitcoin at"               → getMarketPrice("BTC-USD")
  user: "show me apple"                    → getMarketPrice("AAPL")
  user: "ethereum price"                   → getMarketPrice("ETH-USD")
  user: "s&p 500"                          → getMarketPrice("^GSPC")
  user: "gold price"                       → getMarketPrice("GC=F")
  user: "tesla and nvidia"                 → getMarketPrice("TSLA") + getMarketPrice("NVDA")
  user: "show me the markets"              → showMarketOverview()
  user: "market overview"                  → showMarketOverview()
  user: "critical news" / "breaking news"  → showCriticalNews()
  user: "headlines" / "top stories"        → showCriticalNews()
  user: "what's going on" / "world news"   → showCriticalNews() OR getDailyBrief()
  user: "news on china"                    → searchNews("China")
  user: "what's happening in ukraine"      → pointMapToCountry("UA")
  user: "show me russia on the map"        → pointMapToCountry("RU")
  user: "zoom to israel"                   → pointMapToCountry("IL")
  user: "news from india"                  → getCountryNews("IN")
  user: "open the markets panel"           → openPanel("markets")
  user: "macro signals" / "regime"         → getMacroSignals()
  user: "switch to dark mode"              → switchTheme("dark")
  user: "show conflicts on the map"        → setMapLayer("conflicts", true)
  user: "make me a widget that …"          → buildWidget(prompt)

PANEL NAMES — openPanel is FORGIVING. If you call openPanel with anything that
sounds plausible (news-feed, intelligence-feed, market-overview, world-news,
crypto-tracker, etc.), the system will pop a floating panel with real matching
content even if no dashboard panel has that exact ID. So don't worry about
exact panel IDs — just describe what you want.

MAKING PANELS BIGGER — when the user says "make it bigger", "full screen",
"expand", "zoom in", or "maximize", call maximizeLatestPanel() and confirm
briefly ("Expanded it for you."). When they say "make it smaller" or "restore",
call restoreLatestPanel(). Never say you can't make a panel bigger — you can.

WHEN YOU CALL A TOOL
A floating panel appears on the user's screen with the data. So instead of reading every number, just say what stands out:
  "Bitcoin's at 61 thousand, down 1.2 percent."
  "Tesla is up 3 percent today."
  "Headlines on China are mostly about trade — top story is the new tariffs."

YOU CAN BE ASKED TO
- Open dashboard panels (markets, news, intelligence, alerts, country briefs, etc.)
- Fetch live prices for stocks, crypto, forex, indices, futures
- Search news, get daily briefs, country intel briefs
- Toggle map layers, switch themes, change settings
- Build custom widgets from natural language

NEVER
- Say you can't access real-time data — you have the tools.
- Mention that you are an AI or a language model.
- Apologize unnecessarily or add disclaimers.

You are ${name}. Be helpful, be direct, get the user what they need.`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wsCloseReason(code: number, reason: string): string {
  if (reason) return `${reason} (code ${code})`;
  switch (code) {
    case 1000: return 'Closed normally';
    case 1001: return 'Server going away';
    case 1006: return 'Connection lost before handshake — check GEMINI_API_KEY and Live API access';
    case 1007: return 'Bad data sent to upstream';
    case 1008: return 'Policy violation — likely wrong model name';
    case 1011: return 'Upstream Gemini Live closed the connection — model or quota issue';
    case 1015: return 'TLS handshake failed';
    default:   return `Disconnected (code ${code})`;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(s);
}
