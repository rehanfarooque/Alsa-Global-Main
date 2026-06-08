/**
 * Avatar3D — photo-based ARGUS avatar (filename kept for compatibility).
 *
 * Renders a circular portrait inside a rotating orange tick-ring, matching
 * the AlsaTalk reference UI. Implements the AvatarHandle contract so LipSync
 * and GoatMode work without changes.
 *
 * Customization (single source of truth):
 *   - PORTRAIT_URLS  — cascading fallback list for the portrait image
 *   - RING_TICKS     — number of tick marks on the rotating ring
 *   - SPIN_SECONDS   — full revolution duration
 *
 * The handle still takes a canvas (legacy contract) — we hide it and render
 * HTML siblings into its parent so callers don't break.
 */

export interface AvatarHandle {
  setMorph(visemeName: string, intensity: number): void;
  setMood(mood: 'idle' | 'listening' | 'thinking' | 'speaking'): void;
  destroy(): void;
}

// ─── Customization knobs ─────────────────────────────────────────────────────
// Female portraits — matches the female TTS voice (Aoede). Each is a stable
// Unsplash photo of a woman looking at the camera, neutral expression, head
// centered. They cascade — first that loads wins; otherwise fall to SVG.
const PORTRAIT_URLS = [
  'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=720&h=720&fit=crop&crop=faces&q=85',
  'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=720&h=720&fit=crop&crop=faces&q=85',
  'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=720&h=720&fit=crop&crop=faces&q=85',
  'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=720&h=720&fit=crop&crop=faces&q=85',
];
const RING_TICKS = 64;
const SPIN_SECONDS = 36;
// ──────────────────────────────────────────────────────────────────────────────

const STYLE_ID = 'argus-avatar-style';
const STYLE_CSS = `
.argus-avatar {
  position: relative;
  width: min(240px, 34vh);
  height: min(240px, 34vh);
  display: flex;
  align-items: center;
  justify-content: center;
  filter: drop-shadow(0 18px 56px rgba(0, 0, 0, 0.65));
}

.argus-avatar-ring {
  position: absolute;
  inset: 0;
  pointer-events: none;
  animation: argus-spin ${SPIN_SECONDS}s linear infinite;
  transform-origin: 50% 50%;
}
.argus-avatar-ring svg { width: 100%; height: 100%; }
.argus-avatar-ring line {
  stroke: rgba(255, 138, 59, 0.85);
  stroke-width: 2;
  stroke-linecap: round;
}
.argus-avatar[data-mood="listening"] .argus-avatar-ring line { stroke: #00d4ff; }
.argus-avatar[data-mood="thinking"]  .argus-avatar-ring line { stroke: #ffcc00; }
.argus-avatar[data-mood="speaking"]  .argus-avatar-ring line { stroke: #58e6c8; }

.argus-avatar-glow {
  position: absolute;
  inset: 8%;
  border-radius: 50%;
  background: radial-gradient(circle at center, rgba(0, 212, 255, 0.22) 0%, transparent 65%);
  pointer-events: none;
  animation: argus-breath 3.6s ease-in-out infinite;
  filter: blur(4px);
}
.argus-avatar[data-mood="speaking"] .argus-avatar-glow {
  background: radial-gradient(circle at center, rgba(88, 230, 200, 0.32) 0%, transparent 65%);
}

.argus-avatar-orb {
  position: relative;
  width: 78%;
  height: 78%;
  border-radius: 50%;
  overflow: hidden;
  background: linear-gradient(160deg, #1b2230 0%, #0a0e16 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: inset 0 0 60px rgba(0, 0, 0, 0.6), 0 0 0 2px rgba(255, 138, 59, 0.4);
  transition: box-shadow 320ms ease, transform 110ms ease-out;
  will-change: transform;
  z-index: 2;
}

/* Two expanding ripples emanating outward when ARGUS is speaking — feels
   like a real waveform around her, not a flat opacity pulse. */
.argus-avatar::before,
.argus-avatar::after {
  content: '';
  position: absolute;
  inset: 11%;
  border-radius: 50%;
  border: 2px solid transparent;
  pointer-events: none;
  opacity: 0;
  z-index: 1;
}
.argus-avatar[data-mood="speaking"]::before,
.argus-avatar[data-mood="speaking"]::after {
  border-color: rgba(88, 230, 200, 0.55);
  animation: argus-ripple 1.6s cubic-bezier(0.2, 0.6, 0.3, 1) infinite;
}
.argus-avatar[data-mood="speaking"]::after {
  animation-delay: 0.8s;
  border-color: rgba(0, 212, 255, 0.45);
}
@keyframes argus-ripple {
  0%   { transform: scale(1);    opacity: 0.75; }
  70%  { opacity: 0.15; }
  100% { transform: scale(1.45); opacity: 0; }
}
.argus-avatar[data-mood="listening"] .argus-avatar-orb { box-shadow: inset 0 0 60px rgba(0,0,0,0.6), 0 0 0 2px rgba(0,212,255,0.6), 0 0 48px rgba(0,212,255,0.35); }
.argus-avatar[data-mood="speaking"]  .argus-avatar-orb { box-shadow: inset 0 0 60px rgba(0,0,0,0.6), 0 0 0 2px rgba(88,230,200,0.65), 0 0 56px rgba(88,230,200,0.45); }
.argus-avatar[data-mood="thinking"]  .argus-avatar-orb { box-shadow: inset 0 0 60px rgba(0,0,0,0.6), 0 0 0 2px rgba(255,204,0,0.5), 0 0 32px rgba(255,204,0,0.3); }

.argus-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  filter: saturate(0.92) contrast(1.05);
}
.argus-avatar-img.fallback {
  width: 48%;
  height: 48%;
  object-fit: contain;
  opacity: 0.7;
  filter: none;
}

@keyframes argus-spin {
  to { transform: rotate(360deg); }
}
@keyframes argus-breath {
  0%, 100% { opacity: 0.6; transform: scale(1); }
  50%      { opacity: 1.0; transform: scale(1.05); }
}
`;

const FALLBACK_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="#58e6c8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
     <circle cx="32" cy="22" r="9"/>
     <path d="M14 56c0-11 8-18 18-18s18 7 18 18"/>
   </svg>`,
)}`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_CSS;
  document.head.appendChild(style);
}

/** Base y2 per tick — minor=17, major=24. We mutate y2 at runtime to make each
 *  tick "wave" with the voice amplitude. */
const TICK_BASE_Y2 = (i: number): number => (i % 8 === 0 ? 24 : 17);

function buildRingSvg(): string {
  let lines = '';
  for (let i = 0; i < RING_TICKS; i++) {
    const angle = (i / RING_TICKS) * 360;
    const isMajor = i % 8 === 0;
    const y2 = TICK_BASE_Y2(i);
    const sw = isMajor ? 2.8 : 1.8;
    lines += `<line data-tick="${i}" x1="100" y1="6" x2="100" y2="${y2}" stroke-width="${sw}" transform="rotate(${angle} 100 100)"/>`;
  }
  return `<svg viewBox="0 0 200 200" aria-hidden="true">${lines}</svg>`;
}

export async function createAvatar3D(canvas: HTMLCanvasElement): Promise<AvatarHandle> {
  ensureStyle();

  canvas.style.display = 'none';
  const stage = canvas.parentElement;
  if (!stage) return { setMorph() {}, setMood() {}, destroy() {} };

  const wrap = document.createElement('div');
  wrap.className = 'argus-avatar';
  wrap.dataset.mood = 'idle';
  wrap.innerHTML = `
    <div class="argus-avatar-ring">${buildRingSvg()}</div>
    <div class="argus-avatar-glow"></div>
    <div class="argus-avatar-orb">
      <img class="argus-avatar-img" alt="ARGUS" />
    </div>
  `;
  stage.appendChild(wrap);

  const orb = wrap.querySelector<HTMLDivElement>('.argus-avatar-orb')!;
  const img = wrap.querySelector<HTMLImageElement>('.argus-avatar-img')!;

  let urlIndex = 0;
  const tryNextUrl = () => {
    if (urlIndex < PORTRAIT_URLS.length) {
      img.src = PORTRAIT_URLS[urlIndex]!;
      urlIndex++;
    } else {
      img.src = FALLBACK_SVG;
      img.classList.add('fallback');
    }
  };
  img.addEventListener('error', tryNextUrl);
  tryNextUrl();

  // Cache tick line elements so we can mutate y2 every frame without a DOM
  // query per line.
  const tickLines = Array.from(wrap.querySelectorAll<SVGLineElement>('line[data-tick]'));

  // Lip-sync amplitude → orb scale + ring tick wave. Each tick's y2 is a base
  // value (17 minor / 24 major) plus a traveling sine wave scaled by the
  // currently smoothed voice intensity. The wave "rotates" around the circle
  // so it reads like a real circular waveform driven by ARGUS's voice.
  let targetIntensity = 0;
  let currentIntensity = 0;
  let rafId = 0;
  let stopped = false;
  let phase = 0;
  const tick = () => {
    if (stopped) return;
    const k = targetIntensity > currentIntensity ? 0.42 : 0.16;
    currentIntensity += (targetIntensity - currentIntensity) * k;

    // Orb pulse (subtle "talking" wobble)
    const scale = 1 + currentIntensity * 0.05;
    orb.style.transform = `scale(${scale.toFixed(3)})`;

    // Circular waveform: each tick's outer endpoint pushes outward by an
    // amount derived from a traveling sine wave times the smoothed voice
    // intensity. Below a small floor, ticks rest at their base length so
    // the ring stays clean when ARGUS is silent.
    phase += 0.18; // controls travel speed of the wave around the ring
    if (tickLines.length > 0) {
      const amp = currentIntensity;
      const showWave = amp > 0.04;
      for (let i = 0; i < tickLines.length; i++) {
        const base = TICK_BASE_Y2(i);
        let y2 = base;
        if (showWave) {
          // Two interfering sine waves at different speeds → richer pattern
          const wave = Math.sin(phase + i * 0.32) * 0.7
                     + Math.sin(phase * 0.6 - i * 0.18) * 0.3;
          y2 = base + amp * wave * 14;     // up to ~14px push per tick
        }
        // setAttribute is fast on SVG and avoids style recalc cost
        tickLines[i]!.setAttribute('y2', y2.toFixed(1));
      }
    }

    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return {
    setMorph(_name, intensity) {
      targetIntensity = Math.max(0, Math.min(1, intensity));
    },
    setMood(mood) {
      wrap.dataset.mood = mood;
    },
    destroy() {
      stopped = true;
      cancelAnimationFrame(rafId);
      img.removeEventListener('error', tryNextUrl);
      wrap.remove();
    },
  };
}
