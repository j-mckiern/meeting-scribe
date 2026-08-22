import type { TranscriptionQuality } from './types.js';

/**
 * Throws away transcriptions the model appears to have invented.
 *
 * Whisper was trained on captioned video, and when the audio gives it nothing
 * to work with it falls back on what captioned video is full of: "Thank you.",
 * "Thanks for watching!", "Subtitles by the Amara.org community". It reports
 * these with ordinary-looking output and no error. The energy gate stops most
 * of the audio that provokes this from being uploaded at all; what reaches
 * here is the remainder - a real burst of speech with an inaudible word in it,
 * or noise loud enough to clear the gate.
 *
 * Three independent signals, because none of them is reliable alone:
 *
 *  1. **The model's own doubt.** Low confidence *and* a high chance the audio
 *     had no speech in it. Either one alone fires on perfectly good quiet
 *     speech; together they are decisive.
 *  2. **Repetition.** A model stuck in a loop emits the same phrase until the
 *     window ends, which compresses far better than language does.
 *  3. **Repetition across the meeting.** The same short line coming back three
 *     times is a tell no single segment can show. This is why the whole batch
 *     is judged at once rather than each result as it arrives.
 */

/** Above this, the model thinks the audio probably contained no speech. */
const NO_SPEECH_PROB_MAX = 0.6;

/** Below this, it was guessing. Whisper's own decoder uses the same pairing. */
const LOW_CONFIDENCE_LOGPROB = -1;

/** Text that gzips better than this is a phrase repeated, not a sentence. */
const REPETITION_COMPRESSION_RATIO = 2.4;

/** A line no longer than this is short enough for repetition to be suspicious. */
const SHORT_TEXT_CHARS = 40;

/** Occurrences of one short line before the whole set is treated as noise. */
const DUPLICATE_LIMIT = 3;

/**
 * Phrases that belong to captioned video and not to a team meeting. Matched
 * against text stripped to lowercase letters, digits and spaces, so `.` and
 * `!` do not need handling and `Amara.org` arrives as `amara org`.
 *
 * Deliberately narrow. "Okay" and "Yeah" are also things Whisper invents, but
 * they are things people genuinely say, so they are left to the
 * repeated-across-the-meeting rule rather than dropped on sight.
 */
const BOILERPLATE: readonly RegExp[] = [
  /^thanks? (you )?for watching/,
  /^thank you for your (watching|listening)/,
  /^(please )?(like and )?subscribe/,
  /^see you (in the )?next (time|video|one)/,
  /subtitle[sd]? (by|are)/,
  /amara ?org/,
  /^transcri(bed|ption) by/,
  /^(music|applause|laughter|silence|inaudible|blank audio)$/,
];

export interface Judged {
  id: string;
  text: string;
  quality: TranscriptionQuality | null;
}

/**
 * Returns the ids to discard, mapped to why. An id absent from the map is
 * text worth keeping.
 */
export function findHallucinations(candidates: readonly Judged[]): Map<string, string> {
  const discarded = new Map<string, string>();
  const survivors: { id: string; normalized: string }[] = [];

  for (const candidate of candidates) {
    const normalized = normalize(candidate.text);
    const reason = judge(candidate, normalized);

    if (reason !== null) {
      discarded.set(candidate.id, reason);
    } else {
      survivors.push({ id: candidate.id, normalized });
    }
  }

  // Counted over survivors only, so text already discarded cannot push a
  // borderline phrase over the limit.
  const counts = new Map<string, number>();
  for (const { normalized } of survivors) {
    if (normalized.length > SHORT_TEXT_CHARS) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  for (const { id, normalized } of survivors) {
    const count = counts.get(normalized) ?? 0;
    if (count >= DUPLICATE_LIMIT) {
      discarded.set(id, `"${normalized}" appears ${count} times across the meeting`);
    }
  }

  return discarded;
}

/** Everything judgeable from one result alone. Null means keep. */
function judge(candidate: Judged, normalized: string): string | null {
  if (normalized.length === 0) return 'no words';

  for (const pattern of BOILERPLATE) {
    if (pattern.test(normalized)) return `caption boilerplate: "${candidate.text.trim()}"`;
  }

  const { quality } = candidate;
  if (quality === null) return null;

  if (quality.noSpeechProb > NO_SPEECH_PROB_MAX && quality.avgLogProb < LOW_CONFIDENCE_LOGPROB) {
    return (
      `low confidence (logprob ${quality.avgLogProb.toFixed(2)}) on audio the model ` +
      `puts at ${(quality.noSpeechProb * 100).toFixed(0)}% no-speech`
    );
  }

  if (quality.compressionRatio > REPETITION_COMPRESSION_RATIO) {
    return `repetition loop (compression ratio ${quality.compressionRatio.toFixed(2)})`;
  }

  return null;
}

/** Lowercase, letters digits and single spaces only. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
