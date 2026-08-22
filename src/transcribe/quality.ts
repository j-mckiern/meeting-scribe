import type { TranscriptionQuality } from './types.js';

/**
 * Collapses a provider's per-window confidence numbers into one verdict.
 *
 * Shared by every provider rather than living in each, because the whole point
 * of these three numbers is that `hallucinations.ts` compares them against
 * fixed thresholds. If Groq and a local model aggregated them differently, the
 * same audio would be judged differently depending on where it was
 * transcribed - and comparing the two would mean nothing.
 */

/** One decoder window, as both Whisper implementations report it. */
export interface QualityWindow {
  start?: number;
  end?: number;
  avgLogProb?: number;
  noSpeechProb?: number;
  compressionRatio?: number;
}

export function aggregateQuality(windows: readonly QualityWindow[]): TranscriptionQuality | null {
  if (windows.length === 0) return null;

  // Weighted by how much audio each window covers, so a half-second aside does
  // not outvote thirty seconds of clear speech. Compression ratio is taken at
  // its worst instead: one looping window is enough to condemn the result.
  let weight = 0;
  let logProb = 0;
  let noSpeech = 0;
  let compression = 0;

  for (const window of windows) {
    const span = Math.max((window.end ?? 0) - (window.start ?? 0), 0.01);
    weight += span;
    logProb += (window.avgLogProb ?? 0) * span;
    noSpeech += (window.noSpeechProb ?? 0) * span;
    compression = Math.max(compression, window.compressionRatio ?? 0);
  }

  return {
    avgLogProb: logProb / weight,
    noSpeechProb: noSpeech / weight,
    compressionRatio: compression,
  };
}
