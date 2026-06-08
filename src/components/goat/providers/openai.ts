import type {
  InboundEvent,
  ProviderConfig,
  ToolResponse,
  VoiceProvider,
} from './types';

/**
 * OpenAI Realtime API provider.
 *
 * Wire format reference: https://platform.openai.com/docs/api-reference/realtime
 *
 * Differences from Gemini Live we adapt around:
 *   - 24 kHz PCM16 in BOTH directions (Gemini is 16 kHz in, 24 kHz out).
 *   - `session.update` for setup (tools, voice, instructions).
 *   - `input_audio_buffer.append` streams mic audio (no per-frame commit needed
 *     when VAD is server-side, which is the default).
 *   - Function calls arrive as `response.function_call_arguments.done`; we
 *     reply with `conversation.item.create` (type: function_call_output) then
 *     `response.create` to let the model continue.
 */
export class OpenAIRealtimeProvider implements VoiceProvider {
  micSampleRate = 24000;
  playbackSampleRate = 24000;

  private pendingFunctionArgs = new Map<string, { name: string; args: string }>();

  buildSetupMessage(config: ProviderConfig): string {
    const tools = config.tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    return JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: config.systemPrompt,
        voice: mapVoiceName(config.voice),
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
        tools,
        tool_choice: 'auto',
      },
    });
  }

  encodeMicChunk(pcm: Int16Array): string {
    const b64 = bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    return JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: b64,
    });
  }

  encodeTextTurn(text: string): string[] {
    return [
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      }),
      JSON.stringify({ type: 'response.create' }),
    ];
  }

  encodeToolResponses(responses: ToolResponse[]): string[] {
    const frames: string[] = [];
    for (const r of responses) {
      frames.push(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: r.id,
          output: JSON.stringify(r.result),
        },
      }));
    }
    frames.push(JSON.stringify({ type: 'response.create' }));
    return frames;
  }

  parseInbound(rawText: string): InboundEvent[] {
    const events: InboundEvent[] = [];
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(rawText);
    } catch {
      return events;
    }

    const proxyError = msg._proxyError as { reason?: string; message?: string } | undefined;
    if (proxyError) {
      events.push({ kind: 'error', message: proxyError.message || proxyError.reason || 'proxy error' });
      return events;
    }

    const type = msg.type as string | undefined;
    if (!type) return events;

    switch (type) {
      case 'session.created':
      case 'session.updated':
        events.push({ kind: 'ready' });
        break;

      case 'response.audio.delta': {
        const delta = msg.delta as string | undefined;
        if (delta) {
          const bytes = base64ToBytes(delta);
          const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
          events.push({ kind: 'audio', pcm });
        }
        break;
      }

      case 'response.audio_transcript.delta': {
        const delta = msg.delta as string | undefined;
        if (delta) events.push({ kind: 'model_transcript', text: delta });
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = msg.transcript as string | undefined;
        if (transcript) events.push({ kind: 'user_transcript', text: transcript });
        break;
      }

      case 'response.function_call_arguments.delta': {
        const callId = msg.call_id as string | undefined;
        const name = msg.name as string | undefined;
        const delta = msg.delta as string | undefined;
        if (callId) {
          const existing = this.pendingFunctionArgs.get(callId);
          if (existing) {
            existing.args += delta ?? '';
            if (name) existing.name = name;
          } else {
            this.pendingFunctionArgs.set(callId, { name: name ?? '', args: delta ?? '' });
          }
        }
        break;
      }

      case 'response.function_call_arguments.done': {
        const callId = msg.call_id as string | undefined;
        const name = (msg.name as string | undefined) ?? '';
        const argsStr = (msg.arguments as string | undefined) ?? this.pendingFunctionArgs.get(callId ?? '')?.args ?? '{}';
        if (callId) {
          this.pendingFunctionArgs.delete(callId);
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(argsStr || '{}'); } catch { /* keep empty */ }
          events.push({ kind: 'tool_call', id: callId, name, args });
        }
        break;
      }

      case 'error': {
        const err = msg.error as { message?: string; type?: string } | undefined;
        events.push({ kind: 'error', message: err?.message || err?.type || 'OpenAI error' });
        break;
      }
    }

    return events;
  }
}

/**
 * Map Gemini-style voice names to OpenAI Realtime voices. The settings UI
 * stores a single voice slug; we coerce here so the user doesn't have to
 * pick differently per provider. Default = alloy.
 */
function mapVoiceName(name: string): string {
  const allowed = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']);
  if (allowed.has(name)) return name;
  const lookup: Record<string, string> = {
    Aoede: 'alloy',
    Charon: 'ash',
    Fenrir: 'echo',
    Kore: 'shimmer',
    Leda: 'coral',
    Orus: 'verse',
    Puck: 'ballad',
    Zephyr: 'sage',
  };
  return lookup[name] ?? 'alloy';
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