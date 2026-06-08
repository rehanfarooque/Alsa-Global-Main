/**
 * Waveform — dual-channel canvas audio visualizer for the GOAT overlay.
 *
 * Left: user microphone input (dim/grey)
 * Right: ARGUS audio output (cyan, glowing)
 *
 * Each side is a vertical-bar bar-graph driven by the corresponding
 * AnalyserNode's time-domain RMS in narrow frequency bands.
 */

export interface WaveformHandle {
  stop(): void;
}

export function attachWaveform(
  userCanvas: HTMLCanvasElement,
  aiCanvas: HTMLCanvasElement,
  userNode: AudioNode | null,
  aiNode: AudioNode | null,
): WaveformHandle {
  const userCtx = userCanvas.getContext('2d')!;
  const aiCtx = aiCanvas.getContext('2d')!;

  const userAnalyser = userNode ? createAnalyser(userNode) : null;
  const aiAnalyser = aiNode ? createAnalyser(aiNode) : null;

  // Bar config
  const BARS = 28;
  const userColor = 'rgba(255, 255, 255, 0.55)';
  const aiColor = '#00d4ff';

  // Persistent bar values (smoothed)
  const userBars = new Array<number>(BARS).fill(0);
  const aiBars = new Array<number>(BARS).fill(0);

  let rafId = 0;
  let stopped = false;

  const draw = () => {
    if (stopped) return;

    drawSide(userCtx, userCanvas, userAnalyser, userBars, BARS, userColor, false);
    drawSide(aiCtx, aiCanvas, aiAnalyser, aiBars, BARS, aiColor, true);

    rafId = requestAnimationFrame(draw);
  };
  rafId = requestAnimationFrame(draw);

  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(rafId);
      userCtx.clearRect(0, 0, userCanvas.width, userCanvas.height);
      aiCtx.clearRect(0, 0, aiCanvas.width, aiCanvas.height);
    },
  };
}

function createAnalyser(source: AudioNode): AnalyserNode {
  // If the source IS already an AnalyserNode, reuse it
  if (source instanceof AnalyserNode) return source;
  // Otherwise create one and connect
  const a = source.context.createAnalyser();
  a.fftSize = 512;
  source.connect(a);
  return a;
}

function drawSide(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  analyser: AnalyserNode | null,
  bars: number[],
  barCount: number,
  color: string,
  glow: boolean,
): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Pull data
  if (analyser) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    // Group bins into `barCount` segments
    const binsPerBar = Math.floor(data.length / barCount);
    for (let b = 0; b < barCount; b++) {
      let sum = 0;
      for (let i = 0; i < binsPerBar; i++) sum += data[b * binsPerBar + i]!;
      const avg = sum / binsPerBar / 255; // 0..1
      // Smooth toward target
      bars[b] = bars[b]! + (avg - bars[b]!) * 0.4;
    }
  } else {
    // Decay when no source attached
    for (let b = 0; b < barCount; b++) bars[b] = bars[b]! * 0.85;
  }

  const barWidth = Math.max(2, Math.floor(w / barCount) - 2);
  const gap = 2;
  ctx.fillStyle = color;

  if (glow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
  } else {
    ctx.shadowBlur = 0;
  }

  for (let b = 0; b < barCount; b++) {
    const intensity = Math.max(0.05, bars[b]!);
    const barH = Math.max(2, intensity * (h - 4));
    const x = b * (barWidth + gap);
    const y = (h - barH) / 2;
    ctx.fillRect(x, y, barWidth, barH);
  }

  ctx.shadowBlur = 0;
}
