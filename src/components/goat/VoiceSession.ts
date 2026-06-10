/**
 * VoiceSession — provider-agnostic realtime voice bridge for ARGUS.
 *
 *  - Captures mic PCM via Web Audio at the provider's required sample rate
 *  - Streams base64 PCM through /api/goat/live (proxy fans out to upstream)
 *  - Receives PCM audio and plays it via WebAudio so we can tap AnalyserNodes
 *  - Handles tool calls and routes them through the caller's dispatcher
 *
 * The actual wire protocol is delegated to a VoiceProvider:
 *   - GeminiProvider   — Google Gemini Live API
 *   - OpenAIRealtimeProvider — OpenAI Realtime API
 *
 * The server picks the provider via LLM_REALTIME_PROVIDER env var and tells
 * the client which one to use via /api/goat/key.
 */

import type { ToolDefinition } from './AgentTools';
import { GeminiProvider } from './providers/gemini';
import { OpenAIRealtimeProvider } from './providers/openai';
import type { ProviderName, VoiceProvider } from './providers/types';

const MIC_BUFFER_SIZE = 2048;

export type VoiceState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error' | 'closed';

export interface VoiceSessionOptions {
  name: string;
  voice: string;
  provider: ProviderName;
  tools: ToolDefinition[];
  onState: (state: VoiceState, info?: string) => void;
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
  sendText(text: string): void;
}

function createProvider(name: ProviderName): VoiceProvider {
  switch (name) {
    case 'openai': return new OpenAIRealtimeProvider();
    case 'gemini': return new GeminiProvider();
    default: return new GeminiProvider();
  }
}

export async function createVoiceSession(options: VoiceSessionOptions): Promise<VoiceSessionHandle> {
  const provider = createProvider(options.provider);
  const MIC_SAMPLE_RATE = provider.micSampleRate;
  const AI_SAMPLE_RATE = provider.playbackSampleRate;
  console.log(`[VoiceSession] provider=${options.provider} mic=${MIC_SAMPLE_RATE}Hz playback=${AI_SAMPLE_RATE}Hz`);

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

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const processor = (micCtx as unknown as {
    createScriptProcessor: (size: number, ins: number, outs: number) => ScriptProcessorNode;
  }).createScriptProcessor(MIC_BUFFER_SIZE, 1, 1);
  micSource.connect(processor);

  const muteGain = micCtx.createGain();
  muteGain.gain.value = 0;
  processor.connect(muteGain);
  muteGain.connect(micCtx.destination);

  // ── 2a. Web Speech API live captions (early start) ─────────────────────────
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
      console.warn('[VoiceSession] Web Speech setup failed:', (err as Error).message);
    }
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
  const webSpeechActive = webSpeechActiveEarly;

  const setState = (s: VoiceState, info?: string) => {
    if (closed) return;
    if (currentState !== s) {
      currentState = s;
      console.log(`[VoiceSession] state -> ${s}${info ? ` (${info})` : ''}`);
    }
    options.onState(s, info);
  };
  setState('connecting');

  const sendFrames = (frames: string[]) => {
    for (const f of frames) {
      try { ws.send(f); } catch (err) {
        console.warn('[VoiceSession] send failed:', (err as Error).message);
      }
    }
  };

  let setupWatchdog: ReturnType<typeof setTimeout> | null = null;
  ws.addEventListener('open', () => {
    setupWatchdog = setTimeout(() => {
      if (!setupAcked && !closed) {
        console.warn('[VoiceSession] setup ack not received within 12s');
        setState('error', `No setup ack from ${options.provider}. Check server logs.`);
      }
    }, 12_000);
    console.log('[VoiceSession] WebSocket open — sending setup');
    // VITE_ARGUS_MODE=conversation makes ARGUS a pure conversational assistant
    // — no tool calls, no Redis reads. Useful for self-hosted instances that
    // haven't seeded their data layer: the assistant still chats helpfully
    // about world events from the model's training instead of reporting
    // "0 events" because the cache is empty.
    const conversationMode =
      import.meta.env.VITE_ARGUS_MODE === 'conversation';
    const toolsToSend = conversationMode ? [] : options.tools;
    if (conversationMode) {
      console.log('[VoiceSession] conversation mode — tools disabled');
    }
    const setupMsg = provider.buildSetupMessage({
      name: options.provider,
      voice: options.voice,
      agentName: options.name,
      systemPrompt: buildSystemPrompt(options.name, conversationMode),
      tools: toolsToSend,
    });
    sendFrames([setupMsg]);
  });

  ws.addEventListener('error', () => {
    setState('error', 'WebSocket error — check server logs');
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
      setTimeout(() => {
        if (!closed && performance.now() - lastSpeakingAt > 250) {
          setState('listening');
        }
      }, 280);
    };
  };

  // ── 5. Inbound message dispatch (provider-parsed) ──────────────────────────
  ws.addEventListener('message', async (evt) => {
    const text = typeof evt.data === 'string'
      ? evt.data
      : new TextDecoder().decode(evt.data as ArrayBuffer);

    const events = provider.parseInbound(text);
    const toolResponses: Array<{ id: string; name: string; result: unknown }> = [];

    for (const ev of events) {
      switch (ev.kind) {
        case 'ready':
          setupAcked = true;
          if (setupWatchdog) { clearTimeout(setupWatchdog); setupWatchdog = null; }
          console.log(`[VoiceSession] ready — ${options.provider} live`);
          setState('listening', 'Ready');
          break;

        case 'error':
          console.warn(`[VoiceSession] provider error: ${ev.message}`);
          setState('error', ev.message);
          break;

        case 'audio':
          audioChunksReceived++;
          playPcmChunk(ev.pcm);
          break;

        case 'user_transcript':
          if (!webSpeechActive) {
            options.onUserTranscript(ev.text, { isInterim: ev.isInterim });
          }
          break;

        case 'model_transcript':
          options.onModelTranscript(ev.text);
          break;

        case 'tool_call': {
          // Status is set by GoatMode's onToolCall handler (it knows the
          // friendly label map). We just dispatch and log for debug — never
          // surface the raw tool name to the UI.
          console.log(`[VoiceSession] tool call: ${ev.name}`);
          try {
            const result = await options.onToolCall(ev.name, ev.args);
            toolResponses.push({ id: ev.id, name: ev.name, result });
          } catch (err) {
            toolResponses.push({
              id: ev.id,
              name: ev.name,
              result: { error: (err as Error).message },
            });
          }
          break;
        }
      }
    }

    if (toolResponses.length > 0) {
      sendFrames(provider.encodeToolResponses(toolResponses));
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
    try {
      ws.send(provider.encodeMicChunk(pcm16));
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
      if (m) { try { recognition?.stop(); } catch { /* ignore */ } }
      else if (recognition && !closed) { try { (recognition as { start?: () => void }).start?.(); } catch { /* ignore */ } }
    },
    isMuted() { return muted; },
    sendText(text) {
      if (closed || !setupAcked || ws.readyState !== WebSocket.OPEN) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      options.onUserTranscript(trimmed);
      sendFrames(provider.encodeTextTurn(trimmed));
    },
  };
}

// ─── System prompt — tuned for proactive tool use ────────────────────────────
function buildSystemPrompt(name: string, conversationOnly = false): string {
  if (conversationOnly) {
    return `You are ${name} — a warm, capable conversational AI assistant. You're talking with the user by voice, so keep it natural.

VOICE & TONE
- Warm, friendly, conversational — like a knowledgeable friend chatting over coffee.
- Brief by default. One or two short sentences. Expand only when asked.
- Speak naturally — contractions, casual phrasing. Not formal, not robotic.
- Don't read URLs, code, JSON, or markdown aloud. Spoken English only.
- React to what the user says with genuine interest. Ask follow-ups when natural.

HOW TO HANDLE QUESTIONS
- For general knowledge / current events / opinions: answer directly and confidently from what you know.
- For things you genuinely don't know: say so briefly and offer to discuss what you do know.
- Don't constantly disclaim or hedge. The user wants a real conversation, not a wall of caveats.
- Never say "I'm an AI" or "as a language model". Just be ${name}.

CONVERSATION STYLE
- Open-ended user statements ("I'm feeling stuck", "tell me about X") → respond with curiosity and warmth.
- Yes/no questions → answer first, then add one short sentence of context.
- Requests for opinions → give a real opinion, don't hide behind "it depends".

You are ${name}. Be present, be warm, get the user what they need.`;
  }

  return `You are ${name} — a friendly, capable voice assistant for the AlsaGlobal World Monitor dashboard. You help the user understand what's happening in the world, in the markets, and on their screen.

VOICE & TONE
- Warm, natural, conversational — not formal, not robotic. Speak like a knowledgeable friend.
- Brief and clear by default. One or two short sentences. Expand only when the user asks for detail.
- Never say "I'll look that up" or "let me check" — just do it. Action first, then answer.
- Don't read URLs, code, JSON, or markdown aloud. Speak in clean spoken language.

LANGUAGE
- Match the user's language automatically. If they speak Hindi, respond in Hindi. If they
  type in Spanish, reply in Spanish. If they switch mid-conversation, switch with them.
- Tool calls still use English identifiers (symbols, country codes, etc.) regardless of
  the spoken language — e.g. user says "बिटकॉइन का भाव बताओ" → getMarketPrice("BTC-USD")
  → narrate the result in Hindi.
- Numbers and prices stay in their natural English form when speaking (e.g. "sixty-one
  thousand seven hundred") for clarity, even in non-English conversations.

NEVER VERBALIZE TOOL MECHANICS
- Never say tool names like "getMarketPrice", "searchNews", "pointMapToCountry".
- Never say "calling the API", "fetching", "looking it up in the database".
- Never describe what panel is opening — the user can see it.
- Just answer the question naturally. The tools run silently in the background.
  Wrong: "Let me call getMarketPrice for BTC-USD. Bitcoin is at 61,000."
  Right: "Bitcoin's at 61 thousand."

WHEN TOOLS RETURN EMPTY OR FAIL
- NEVER read any error message, timeout warning, status code, "no data", "0 events",
  "unavailable", or technical reason out loud. The user does not want to hear it.
- If a tool returns { ok: false } or { error: ... } or { code: ... }, treat it as
  silent. Pivot to a different tool that could answer, OR answer briefly from
  your general knowledge.
- buildWidget specifically can return { ok: false, code: 'unavailable' } — if so,
  do NOT mention it failed. Either skip the visual and answer the question with
  the data you already have, or briefly say "let me show you another way" and
  use a different tool (openChart, openWatchlist, getMarketPrice).
- "Don't have the latest on that" is your only allowed acknowledgement of a
  failure — and only when you genuinely can't answer at all.
- The user wants conversation and answers, not status reports.

DECIDE FOR THE USER — DO NOT WAIT TO BE TOLD WHAT TOOL TO USE.
The user speaks in natural language. They will never say "open the markets
panel" or "call getMarketPrice". They say things like "what's hot today",
"how are things in Ukraine", "I'm worried about Tesla". Your job is to
INFER which combination of tools answers their real intent, fire those
tools, then narrate the result in one or two natural sentences.

YOUR DECISION LOOP for every user turn:
  1. What is the user actually asking? (status update? specific price? country?
     visualization? read what's on screen?)
  2. Is the answer probably already on the dashboard? Call scanDashboard()
     first when the question is broad ("what's going on", "anything new",
     "summarize", "what should I know"). Pick the 1-3 most relevant panels
     from the result and spotlightPanel each, then narrate from their snippets.
  3. Is there a specific live-data tool that fits? (price → getMarketPrice,
     chart → openChart, comparison → compareSymbols, conversion →
     convertCurrency, country → pointMapToCountry + getCountryNews, etc.)
  4. Fire tools in parallel when possible — don't serialize unnecessarily.
  5. Speak ONE clear, short sentence. The visuals do the heavy lifting.

INTENT → ORCHESTRATION (think this way, NOT as keyword lookups):

  intent: "tell me what's happening"
    → scanDashboard() → spotlightPanel(most-newsworthy-panel-id)
    → optionally readPanel(another-panel-id) → narrate the top 2 headlines

  intent: "I want to see Bitcoin" / "show me Tesla" / "look up gold" / "let me see X"
    → showAsset("bitcoin")   (or "tesla", "gold", "TSLA", "BTC-USD" — loose terms work)
    → showAsset is the DEFAULT for any "see X" / "show X" / "look at X" intent.
       It pops BOTH the live price tile AND the TradingView chart in parallel.
       NEVER pick between price and chart — give them both.
    → "Bitcoin's at sixty-one thousand, down two and a half percent. Chart's up."

  intent: "What's bitcoin at" (price only, no chart needed)
    → getMarketPrice("BTC-USD")    (use this if user explicitly only wants price)

  intent: "Show me the Tesla chart" (chart only, explicit)
    → openChart("NASDAQ:TSLA")     (use this if user explicitly only wants chart)

  intent: "How's the world looking today"
    → getDailyBrief() + scanDashboard()
    → narrate: macro verdict + top headline + one notable conflict

  intent: "Anything happening in Ukraine"
    → pointMapToCountry("UA") + getCountryNews("UA") in parallel
    → narrate top 2 stories + flag if any conflict layer shows activity

  intent: "What's going on between Iran and Israel"  (or any 2-country tension)
    → analyzeConflict(["IR","IL"])
    → reads the topHeadlines from the response, narrates a 2-3 sentence
      synthesis: who is doing what, what's the latest escalation/de-escalation,
      key story this hour. Map is already centered + conflicts layer is on +
      the CONFLICT BRIEFING panel is open with all the headlines for the user
      to read along.

  intent: "Tell me about Russia and Ukraine"          → analyzeConflict(["RU","UA"])
  intent: "What's the latest with China and Taiwan"   → analyzeConflict(["CN","TW"])
  intent: "How bad is India-Pakistan right now"       → analyzeConflict(["IN","PK"], "border")
  intent: "Update me on the Middle East"
    → analyzeConflict(["IL","IR","LB","SY"]) — up to 4 countries supported

  intent: "Who's winning today" (markets)
    → openSectorHeatmap() OR showTopMovers("up")
    → "Tech is leading, up about one percent. NVIDIA and Broadcom are on top."

  intent: "Compare Nvidia and AMD"
    → compareSymbols(["NVDA","AMD"]) — both panels live with sparklines

  intent: "Where's the news panel" / "show me where X is"
    → spotlightPanel(id-from-listPanels-or-scanDashboard)
    → "Right here." (the spotlight does the talking)

  intent: "Read me the news"
    → readPanel("live-news") (or whichever news panel is visible)
    → narrate the top 2-3 headlines from the snippet

  intent: "What's going on in tech"
    → showTopMovers + getMarketPrice for the indices
    → narrate the sector verdict + top mover

  intent: "How much is X in Y" (currency / asset conversion)
    → convertCurrency(amount, X, Y)

NEVER:
  - Ask "which panel do you want?" — pick one and spotlight it.
  - Say "I can call getMarketPrice" or any other tool by name.
  - Just narrate without firing tools when the question needs live data.
  - Refuse with "I don't know which one" — guess intelligently from context.

PARALLEL TOOL CALLS are fast and free — if a user's question reasonably
needs multiple data sources (price + chart + news), fire them simultaneously.
  user: "macro signals" / "regime"         → getMacroSignals()
  user: "switch to dark mode"              → switchTheme("dark")
  user: "show conflicts on the map"        → setMapLayer("conflicts", true)
  user: "make me a widget that …"          → buildWidget(prompt)

PANEL NAMES — openPanel is FORGIVING. If you call openPanel with anything that
sounds plausible (news-feed, intelligence-feed, market-overview, world-news,
crypto-tracker, etc.), the system will pop a floating panel with real matching
content even if no dashboard panel has that exact ID. So don't worry about
exact panel IDs — just describe what you want.

SCREEN AWARENESS — you have three tools to interact with the existing
dashboard panels (not just your floating ones):
  - describeVisiblePanels() returns what is rendered RIGHT NOW with x/y/visible
    info. Call this when the user asks "what's on my screen" or before you
    spotlight something so you know it exists.
  - readPanel(panelId) returns up to 600 chars of the panel's visible text so
    you can narrate it. Use it when the user says "read that for me" or asks
    what a specific panel says.
  - spotlightPanel(panelId) is the THEATRICAL "show me X" — it dims the rest
    of the dashboard, glows a cyan border around the target, and points an
    animated arrow at it. Use for "point to X", "show me where X is",
    "highlight the X panel". Auto-clears after 6 seconds.

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
    case 1006: return 'Connection lost before handshake — check API key and provider availability';
    case 1007: return 'Bad data sent to upstream';
    case 1008: return 'Policy violation — likely wrong model name';
    case 1011: return 'Upstream closed the connection — model, quota, or region issue';
    case 1015: return 'TLS handshake failed';
    default:   return `Disconnected (code ${code})`;
  }
}
