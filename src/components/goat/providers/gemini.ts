import type {
  InboundEvent,
  ProviderConfig,
  ToolResponse,
  VoiceProvider,
} from './types';

const GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';

export class GeminiProvider implements VoiceProvider {
  micSampleRate = 16000;
  playbackSampleRate = 24000;

  buildSetupMessage(config: ProviderConfig): string {
    return JSON.stringify({
      setup: {
        model: `models/${GEMINI_LIVE_MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } },
          },
        },
        systemInstruction: { parts: [{ text: config.systemPrompt }] },
        tools: config.tools.length > 0
          ? [{ functionDeclarations: config.tools }]
          : undefined,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });
  }

  encodeMicChunk(pcm: Int16Array): string {
    const b64 = bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    return JSON.stringify({
      realtimeInput: {
        audio: { mimeType: 'audio/pcm;rate=16000', data: b64 },
      },
    });
  }

  encodeTextTurn(text: string): string[] {
    return [JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      },
    })];
  }

  encodeToolResponses(responses: ToolResponse[]): string[] {
    return [JSON.stringify({
      toolResponse: {
        functionResponses: responses.map((r) => ({
          id: r.id,
          name: r.name,
          response: { result: r.result },
        })),
      },
    })];
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

    if (msg.setupComplete) {
      events.push({ kind: 'ready' });
      return events;
    }

    const sc = msg.serverContent as {
      modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; text?: string }> };
      inputTranscription?: { text?: string };
      outputTranscription?: { text?: string };
    } | undefined;

    if (sc) {
      const parts = sc.modelTurn?.parts ?? [];
      for (const part of parts) {
        if (part.inlineData?.mimeType?.startsWith('audio/pcm') && part.inlineData.data) {
          const bytes = base64ToBytes(part.inlineData.data);
          const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
          events.push({ kind: 'audio', pcm });
        }
        if (part.text) {
          events.push({ kind: 'model_transcript', text: part.text });
        }
      }
      if (sc.inputTranscription?.text) {
        events.push({ kind: 'user_transcript', text: sc.inputTranscription.text });
      }
      if (sc.outputTranscription?.text) {
        events.push({ kind: 'model_transcript', text: sc.outputTranscription.text });
      }
    }

    const tc = msg.toolCall as { functionCalls?: Array<{ id: string; name: string; args?: Record<string, unknown> }> } | undefined;
    if (tc?.functionCalls) {
      for (const call of tc.functionCalls) {
        events.push({
          kind: 'tool_call',
          id: call.id,
          name: call.name,
          args: call.args ?? {},
        });
      }
    }

    return events;
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