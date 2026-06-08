import type { ToolDefinition } from '../AgentTools';

export type ProviderName = 'gemini' | 'openai';

export interface ProviderConfig {
  name: ProviderName;
  voice: string;
  agentName: string;
  systemPrompt: string;
  tools: ToolDefinition[];
}

export interface InboundAudio {
  kind: 'audio';
  pcm: Int16Array;
}

export interface InboundUserTranscript {
  kind: 'user_transcript';
  text: string;
  isInterim?: boolean;
}

export interface InboundModelTranscript {
  kind: 'model_transcript';
  text: string;
}

export interface InboundToolCall {
  kind: 'tool_call';
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface InboundReady {
  kind: 'ready';
}

export interface InboundError {
  kind: 'error';
  message: string;
}

export type InboundEvent =
  | InboundAudio
  | InboundUserTranscript
  | InboundModelTranscript
  | InboundToolCall
  | InboundReady
  | InboundError;

export interface ToolResponse {
  id: string;
  name: string;
  result: unknown;
}

/**
 * VoiceProvider abstracts the upstream LLM protocol (Gemini Live / OpenAI Realtime).
 * The transport (WebSocket via /api/goat/live proxy) is shared; only the message
 * shapes and the upstream PCM sample rate differ between providers.
 */
export interface VoiceProvider {
  /** PCM sample rate the upstream model expects for mic input. */
  micSampleRate: number;
  /** PCM sample rate the upstream model returns for playback audio. */
  playbackSampleRate: number;
  /** Build the initial setup message sent on WS open. */
  buildSetupMessage(config: ProviderConfig): string;
  /** Encode mic PCM16 chunk into a single wire frame. */
  encodeMicChunk(pcm: Int16Array): string;
  /** Encode a text turn — may emit multiple frames (e.g. OpenAI item.create + response.create). */
  encodeTextTurn(text: string): string[];
  /** Encode tool-call responses — may emit multiple frames. */
  encodeToolResponses(responses: ToolResponse[]): string[];
  /** Parse one inbound WS message into normalized events. */
  parseInbound(rawText: string): InboundEvent[];
}