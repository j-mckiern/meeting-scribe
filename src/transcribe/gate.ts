import { formatDbfs, measureLoudness, type Loudness } from './audio.js';

/**
 * Decides whether a segment is worth sending to the model.
 *
 * This exists because Whisper does not return nothing for nothing. Fed a
 * second of room tone it returns "Thank you." or "Thanks for watching!" with
 * every appearance of confidence, and those inventions then flow into the
 * summary as things people said. Filtering the output afterwards
 * (`hallucinations.ts`) catches what gets through; not uploading silence in
 * the first place is cheaper, faster, and does not depend on guessing which
 * sentences a model made up.
 *
 * Capture already drops bursts under 400 ms, so this is not a duplicate of
 * that check: capture knows how long a burst was, and this knows whether
 * anything in it was loud enough to be a voice.
 */

/**
 * A 20 ms window quieter than this is background: a fan, a keyboard, or the
 * silence `SegmentSink` pads gaps with. Speech peaking at a very quiet -30
 * dBFS still measures around -40 RMS, so this leaves a good margin below even
 * a bad microphone.
 */
const ACTIVE_WINDOW_DBFS = -50;

/**
 * If the single loudest sample in the whole segment is below this, nobody was
 * talking into a microphone. Normal Discord speech peaks near -10 dBFS.
 */
const MIN_PEAK_DBFS = -45;

/** Less speech than this is a cough, a chair, or a door - never a sentence. */
const MIN_SPEECH_MS = 300;

/** And a segment shorter than this cannot contain MIN_SPEECH_MS anyway. */
const MIN_DURATION_MS = 500;

export interface GateVerdict {
  transcribe: boolean;
  /** Why it was rejected, for the log and the transcript stats. Null if kept. */
  reason: string | null;
  loudness: Loudness;
}

export function gate(pcm: Buffer, sampleRate: number, durationMs: number): GateVerdict {
  const loudness = measureLoudness(pcm, sampleRate, ACTIVE_WINDOW_DBFS);

  const reason =
    durationMs < MIN_DURATION_MS
      ? `only ${Math.round(durationMs)} ms long`
      : loudness.peakDbfs < MIN_PEAK_DBFS
        ? `never louder than ${formatDbfs(loudness.peakDbfs)}`
        : loudness.speechMs < MIN_SPEECH_MS
          ? `only ${Math.round(loudness.speechMs)} ms above the noise floor`
          : null;

  return { transcribe: reason === null, reason, loudness };
}
