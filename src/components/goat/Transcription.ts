/**
 * Transcription — rolling live captions for the GOAT overlay.
 *
 * Two modes per speaker:
 *   - final  → committed text, coalesces with prior same-speaker line
 *   - interim → live caption that overwrites itself until a final arrives
 *
 * Interim captions are how the Web Speech API surfaces words mid-utterance:
 * they let the operator see the words as they speak, not after the pause.
 * When a final result lands we lock that line and move on.
 */

export interface TranscriptionHandle {
  append(who: 'user' | 'argus', text: string, opts?: { interim?: boolean }): void;
  clear(): void;
}

const MAX_LINES = 6;
const FADE_AFTER_MS = 8000;

export function createTranscription(container: HTMLElement): TranscriptionHandle {
  let lastWho: 'user' | 'argus' | null = null;
  let lastLine: HTMLDivElement | null = null;
  // Track the per-speaker interim line so we can overwrite it cleanly when
  // the next interim chunk arrives, then convert it to a committed line on final.
  let interimLine: { who: 'user' | 'argus'; el: HTMLDivElement } | null = null;
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;

  const resetFade = () => {
    if (fadeTimer) clearTimeout(fadeTimer);
    container.querySelectorAll('.goat-trans-line.fading').forEach((el) => el.classList.remove('fading'));
    fadeTimer = setTimeout(() => {
      container.querySelectorAll('.goat-trans-line').forEach((el) => el.classList.add('fading'));
    }, FADE_AFTER_MS);
  };

  const buildLine = (who: 'user' | 'argus', text: string, isInterim: boolean): HTMLDivElement => {
    const line = document.createElement('div');
    line.className = `goat-trans-line${isInterim ? ' interim' : ''}`;
    line.innerHTML =
      `<span class="goat-trans-who goat-trans-who-${who}">${who === 'argus' ? 'ARGUS' : 'YOU'}</span>` +
      `<span class="goat-trans-text"></span>`;
    line.querySelector<HTMLSpanElement>('.goat-trans-text')!.textContent = text;
    return line;
  };

  const trimLines = () => {
    while (container.children.length > MAX_LINES) container.firstChild?.remove();
  };

  return {
    append(who, text, opts) {
      if (!text) return;
      const isInterim = opts?.interim === true;

      if (isInterim) {
        // Overwrite the per-speaker interim line in place; never accumulates.
        if (interimLine && interimLine.who === who) {
          const span = interimLine.el.querySelector<HTMLSpanElement>('.goat-trans-text');
          if (span) span.textContent = text;
        } else {
          // Different speaker started talking — close out any other interim line
          if (interimLine) interimLine.el.remove();
          const line = buildLine(who, text, true);
          container.appendChild(line);
          interimLine = { who, el: line };
          trimLines();
        }
        container.scrollTop = container.scrollHeight;
        resetFade();
        return;
      }

      // Final result. If there's an interim line for this speaker, lock it in.
      if (interimLine && interimLine.who === who) {
        const span = interimLine.el.querySelector<HTMLSpanElement>('.goat-trans-text');
        if (span) span.textContent = text;
        interimLine.el.classList.remove('interim');
        lastWho = who;
        lastLine = interimLine.el;
        interimLine = null;
      } else if (who === lastWho && lastLine) {
        // Same-speaker burst → coalesce onto the previous line
        const span = lastLine.querySelector<HTMLSpanElement>('.goat-trans-text');
        if (span) span.textContent = (span.textContent ?? '') + text;
      } else {
        // Fresh committed line
        if (interimLine) { interimLine.el.remove(); interimLine = null; }
        const line = buildLine(who, text, false);
        container.appendChild(line);
        lastWho = who;
        lastLine = line;
        trimLines();
      }
      container.scrollTop = container.scrollHeight;
      resetFade();
    },
    clear() {
      container.innerHTML = '';
      lastWho = null;
      lastLine = null;
      interimLine = null;
      if (fadeTimer) clearTimeout(fadeTimer);
    },
  };
}
