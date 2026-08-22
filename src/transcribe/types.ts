import type { Participant } from '../capture/types.js';

/**
 * The vocabulary the summarisation stage speaks.
 *
 * Capture's output is audio on disk; this stage's output is words on a
 * timeline. Nothing here mentions a provider, because which model produced the
 * words is a deployment detail - Groq now, local faster-whisper later.
 */

/** One thing one person said, placed on the meeting's timeline. */
export interface Utterance {
  userId: string;
  displayName: string;
  /** Offset from the start of the meeting, matching the segment it came from. */
  startMs: number;
  durationMs: number;
  text: string;
}

/**
 * Why the utterance count does not match the segment count. Written into the
 * transcript because "the model only heard half the meeting" and "half the
 * meeting was someone's fan" are indistinguishable without it.
 */
export interface TranscriptStats {
  /** Segments the manifest listed. */
  segments: number;
  /** Segments that became an utterance. */
  transcribed: number;
  /** Gated out before upload: too short, too quiet, or silence. */
  skippedQuiet: number;
  /** Transcribed, then thrown away as hallucinated. */
  discarded: number;
  /** The provider failed on these. They are simply missing. */
  failed: number;
}

/**
 * How long it took, and how that compares across machines.
 *
 * Recorded because the interesting question about a self-hosted model is not
 * "did it work" but "how long will a real meeting take on this box". Wall
 * clock alone does not answer that - a 40-minute meeting and a 4-minute one
 * are not comparable. `realtimeFactor` is, so the same recording run on a
 * laptop and on a desktop produces two numbers that mean something together.
 */
export interface TranscriptTiming {
  /** Seconds of audio actually sent to the model, after the gate. */
  audioSeconds: number;
  /** ffmpeg conversion and loudness measurement. */
  prepareSeconds: number;
  /** The model, including the one-off cost of loading it. */
  transcribeSeconds: number;
  /** audioSeconds / transcribeSeconds. Above 1 is faster than real time. */
  realtimeFactor: number;
}

/**
 * `transcript.json`, the contract between this stage and summarisation.
 *
 * Deliberately self-contained rather than a pointer back at the manifest: the
 * retention model deletes the audio once this file exists, and `/retry` has to
 * work months later against nothing but this.
 */
export interface MeetingTranscript {
  version: 1;
  meetingId: string;
  title: string | null;
  startedAt: string;
  endedAt: string | null;
  transcribedAt: string;
  provider: string;
  model: string;
  participants: Participant[];
  /** Sorted by startMs, so reading top to bottom replays the conversation. */
  utterances: Utterance[];
  stats: TranscriptStats;
  timing: TranscriptTiming;
}

/** One audio file handed to a provider. */
export interface TranscriptionJob {
  /** The caller's handle for this job; results are matched back by it. */
  id: string;
  /** Absolute path to an audio file the provider accepts. */
  path: string;
  /**
   * Vocabulary hint - names and jargon the model would otherwise mangle.
   * Whisper treats this as text preceding the audio, so it biases the output
   * as well as informing it. That is the point, and also the risk.
   */
  prompt?: string;
}

/**
 * The model's own doubts about what it just produced.
 *
 * Whisper does not report "I heard nothing"; it reports low confidence and
 * then writes a plausible sentence anyway. These three numbers are what makes
 * that detectable after the fact.
 */
export interface TranscriptionQuality {
  /** Mean token log-probability. Roughly -0.1 when sure, below -1 when guessing. */
  avgLogProb: number;
  /** The model's estimated probability that the audio contains no speech. */
  noSpeechProb: number;
  /** gzip ratio of the text. High means the model looped on one phrase. */
  compressionRatio: number;
}

export interface TranscriptionResult {
  id: string;
  text: string;
  /** Null when the provider does not report quality signals. */
  quality: TranscriptionQuality | null;
  /** Set when this one job failed; the rest of the batch still succeeded. */
  error?: string;
}

/**
 * A transcription backend.
 *
 * Batch in, batch out - not one call per segment. Local inference wants to
 * batch and owns its own concurrency; a per-segment interface would suit the
 * hosted API and fight the local one. Deciding how many requests to have in
 * flight is the implementation's business, not the caller's.
 *
 * An implementation throws only for failures that make the whole batch
 * pointless (a rejected API key). Anything wrong with a single file belongs in
 * that result's `error`.
 */
export interface Transcriber {
  /** Short identifier recorded in the transcript, e.g. `groq`. */
  readonly name: string;
  readonly model: string;
  transcribe(jobs: readonly TranscriptionJob[]): Promise<TranscriptionResult[]>;
}
