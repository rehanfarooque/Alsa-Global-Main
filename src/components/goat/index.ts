/**
 * GOAT mode (ARGUS) — public surface for the voice AI assistant.
 *
 * Internal modules:
 *   - GoatMode.ts       — overlay orchestrator
 *   - Avatar3D.ts       — Three.js scene + GLB loader + procedural fallback
 *   - VoiceSession.ts   — STT + Gemini + TTS loop
 *   - LipSync.ts        — audio → viseme blendshapes
 *   - AgentTools.ts     — function-call schema + dispatcher
 *   - Transcription.ts  — live caption UI
 *   - Waveform.ts       — dual-channel audio visualization
 *
 * Only GoatMode is consumed by app code (event-handlers.ts).
 */
export {
  openGoatMode,
  closeGoatMode,
  toggleGoatMode,
  isGoatActive,
  getGoatName,
  setGoatName,
  getGoatVoice,
  setGoatVoice,
} from './GoatMode';

export type { AvatarHandle } from './Avatar3D';
export type { VoiceSessionHandle, VoiceState } from './VoiceSession';
export type { ToolDefinition, AgentToolsHandle } from './AgentTools';
