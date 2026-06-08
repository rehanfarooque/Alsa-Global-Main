/**
 * LipSync — drives viseme blendshapes from the AI's audio output in real time.
 *
 * Algorithm:
 *   1. Tap an AnalyserNode on the playback graph (24 kHz mono).
 *   2. Each animation frame, read frequency-domain data.
 *   3. Locate the first two formants F1, F2 via peak-picking in the
 *      200-3500 Hz band.
 *   4. Map (F1, F2) → nearest viseme using canonical formant centroids.
 *   5. Compute overall amplitude (RMS) → drives morph intensity.
 *   6. Send to Avatar3D.setMorph() with one-euro smoothing on intensity.
 *
 * Result: the avatar's mouth moves in sync with whatever ARGUS is saying.
 */

import type { AvatarHandle } from './Avatar3D';

interface VisemeCentroid {
  name: string;
  f1: number;
  f2: number;
}

// Canonical formant frequencies for English visemes.
// Sources: averages from Peterson & Barney 1952, calibrated for synthetic TTS.
const VISEME_CENTROIDS: VisemeCentroid[] = [
  { name: 'viseme_aa', f1: 730, f2: 1100 },  // father, lot
  { name: 'viseme_E',  f1: 600, f2: 1900 },  // bed, get
  { name: 'viseme_I',  f1: 300, f2: 2300 },  // beat, see
  { name: 'viseme_O',  f1: 500, f2: 900  },  // boat, go
  { name: 'viseme_U',  f1: 320, f2: 800  },  // boot, you
];

const CLOSURE_VISEMES = ['viseme_PP', 'viseme_FF', 'viseme_sil'];

export interface LipSyncHandle {
  stop(): void;
}

export function startLipSync(source: AudioNode, avatar: AvatarHandle): LipSyncHandle {
  // Accept any AudioNode; if it isn't already an AnalyserNode, create one and tap it.
  const analyser: AnalyserNode = source instanceof AnalyserNode
    ? source
    : (() => {
        const a = source.context.createAnalyser();
        a.fftSize = 2048;
        source.connect(a);
        return a;
      })();
  const sampleRate = analyser.context.sampleRate;
  const fftSize = analyser.frequencyBinCount * 2;
  const binCount = analyser.frequencyBinCount;
  const binHz = sampleRate / fftSize;

  const freqData = new Float32Array(binCount);
  const timeData = new Float32Array(analyser.fftSize);

  // One-euro filter state for smoothing morph intensity
  let lastValue = 0;
  let lastTime = performance.now();

  // Frequency-bin index ranges (lazy: convert Hz → bin once)
  const minBin = Math.max(2, Math.floor(200 / binHz));
  const maxBin = Math.min(binCount - 1, Math.floor(3500 / binHz));
  const f1MaxBin = Math.min(binCount - 1, Math.floor(1100 / binHz));
  const f2MinBin = Math.max(minBin, Math.floor(800 / binHz));

  let rafId = 0;
  let stopped = false;
  let lastViseme = 'viseme_sil';

  const tick = () => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(timeData);
    analyser.getFloatFrequencyData(freqData);

    // RMS for amplitude (mouth open intensity)
    let sumSq = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = timeData[i]!;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / timeData.length);

    // Normalize RMS to [0, 1] with a soft knee
    const rawIntensity = Math.min(1, Math.pow(rms * 12, 0.7));

    // One-euro smoothing
    const now = performance.now();
    const dt = Math.max(0.001, (now - lastTime) / 1000);
    lastTime = now;
    const minCutoff = 2.5;
    const beta = 0.012;
    const dValue = (rawIntensity - lastValue) / dt;
    const cutoff = minCutoff + beta * Math.abs(dValue);
    const alpha = 1 / (1 + sampleRate / (2 * Math.PI * cutoff * sampleRate));
    const smooth = lastValue + alpha * (rawIntensity - lastValue);
    lastValue = smooth;

    // Find F1: strongest peak in 200..1100 Hz
    const f1Bin = findPeakBin(freqData, minBin, f1MaxBin);
    // Find F2: strongest peak in 800..3500 Hz, above f1
    const f2Bin = findPeakBin(freqData, Math.max(f2MinBin, f1Bin + 4), maxBin);

    const f1Hz = f1Bin * binHz;
    const f2Hz = f2Bin * binHz;

    // Pick viseme: closure if amplitude very low, else nearest centroid
    let viseme = lastViseme;
    if (smooth < 0.05) {
      viseme = 'viseme_sil';
    } else if (f1Bin > 0 && f2Bin > 0) {
      viseme = nearestViseme(f1Hz, f2Hz);
    }

    // If viseme changed, decay the previous one
    if (viseme !== lastViseme) {
      avatar.setMorph(lastViseme, 0);
      lastViseme = viseme;
    }

    // Drive the active viseme + ensure all closure visemes are zeroed (unless active)
    avatar.setMorph(viseme, smooth);
    for (const closure of CLOSURE_VISEMES) {
      if (closure !== viseme) avatar.setMorph(closure, 0);
    }

    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(rafId);
      // Reset all visemes to neutral
      for (const c of VISEME_CENTROIDS) avatar.setMorph(c.name, 0);
      for (const c of CLOSURE_VISEMES) avatar.setMorph(c, 0);
    },
  };
}

function findPeakBin(freqData: Float32Array, lo: number, hi: number): number {
  let bestBin = -1;
  let bestVal = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const v = freqData[i]!;
    if (v > bestVal) {
      bestVal = v;
      bestBin = i;
    }
  }
  // Only return if peak is significantly above noise floor (~-60dB)
  if (bestVal < -55) return -1;
  return bestBin;
}

function nearestViseme(f1: number, f2: number): string {
  let bestName = 'viseme_aa';
  let bestDist = Infinity;
  for (const c of VISEME_CENTROIDS) {
    // Weight F2 less than F1 since F2 is more variable in synthetic speech
    const df1 = (f1 - c.f1) / 400;
    const df2 = (f2 - c.f2) / 800;
    const d = df1 * df1 + df2 * df2 * 0.6;
    if (d < bestDist) {
      bestDist = d;
      bestName = c.name;
    }
  }
  return bestName;
}
