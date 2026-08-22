import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifest } from '../capture/manifest.js';
import type { AudioSegment, MeetingManifest } from '../capture/types.js';
import { log } from '../logger.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { readWav, toWhisperAudio, type Loudness } from './audio.js';
import { gate, type GateVerdict } from './gate.js';
import { findHallucinations } from './hallucinations.js';
import { writeTranscript } from './transcript.js';
import type {
  MeetingTranscript,
  Transcriber,
  TranscriptStats,
  TranscriptTiming,
  TranscriptionJob,
  TranscriptionResult,
  Utterance,
} from './types.js';

/**
 * Stage two of the pipeline: a directory of per-speaker audio in, a transcript
 * on a timeline out.
 *
 * Three passes, in this order for a reason:
 *
 *  1. **Prepare** - convert to what Whisper wants and measure it. Local, CPU
 *     bound, and it decides what never needs uploading at all.
 *  2. **Transcribe** - one batch handed to the provider, which owns its own
 *     concurrency.
 *  3. **Judge** - discard what the model appears to have invented. Done over
 *     the whole batch because the strongest signal (the same line coming back
 *     three times) is invisible from any single result.
 *
 * Attribution is free here: capture wrote one file per speaker, so the speaker
 * is already known and no diarization is involved. What the model loses in
 * exchange is conversational context - it hears one side of the meeting at a
 * time - which is what the vocabulary prompt is compensating for.
 */

/** ffmpeg is CPU bound and short-lived; this is about matching a small VPS. */
const CONVERT_CONCURRENCY = 4;

/** Stand-in for a segment that never got as far as being measured. */
const UNMEASURED: Loudness = { peakDbfs: -Infinity, speechMs: 0, speechDbfs: -Infinity };

export interface TranscribeOptions {
  transcriber: Transcriber;
  /** Extra names, products and jargon to prime the model with. */
  vocabulary?: string;
}

/**
 * Transcribes a captured meeting directory and writes `transcript.json` into
 * it. The manifest is the only input: anything in `audio/` it does not list is
 * not real audio.
 */
export async function transcribeMeeting(
  dir: string,
  options: TranscribeOptions,
): Promise<MeetingTranscript> {
  const manifest = await readManifest(dir);
  const transcript = await transcribeSegments(dir, manifest, options);

  await writeTranscript(dir, transcript);
  return transcript;
}

/**
 * The same work without touching the meeting directory, taking the manifest as
 * an argument. Lets a tool point this at a single podcast clip with a manifest
 * made up on the spot, which is how a Whisper problem gets told apart from a
 * capture problem.
 */
export async function transcribeSegments(
  dir: string,
  manifest: MeetingManifest,
  options: TranscribeOptions,
): Promise<MeetingTranscript> {
  const { transcriber } = options;
  const prompt = buildPrompt(manifest, options.vocabulary);

  const workDir = await mkdtemp(join(tmpdir(), 'meeting-scribe-'));

  try {
    const prepareStarted = Date.now();
    const prepared = await prepare(dir, manifest.segments, workDir);
    const prepareSeconds = (Date.now() - prepareStarted) / 1000;

    const jobs: TranscriptionJob[] = prepared
      .filter((item) => item.path !== null)
      .map((item) => ({ id: item.id, path: item.path!, prompt }));

    log.info(
      `Transcribing ${jobs.length} of ${manifest.segments.length} segments ` +
        `with ${transcriber.name}/${transcriber.model}`,
    );

    const transcribeStarted = Date.now();
    const results = jobs.length === 0 ? [] : await transcriber.transcribe(jobs);
    const transcribeSeconds = (Date.now() - transcribeStarted) / 1000;

    // Only the audio that actually reached the model - counting what the gate
    // dropped would flatter the realtime factor.
    const audioSeconds =
      prepared.filter((item) => item.path !== null).reduce((total, item) => total + item.audioMs, 0) /
      1000;

    const timing: TranscriptTiming = {
      audioSeconds: round(audioSeconds),
      prepareSeconds: round(prepareSeconds),
      transcribeSeconds: round(transcribeSeconds),
      realtimeFactor: transcribeSeconds > 0 ? round(audioSeconds / transcribeSeconds) : 0,
    };

    return assemble(manifest, prepared, results, transcriber, timing);
  } finally {
    // Converted copies of the audio, and nothing else. Losing them costs a
    // re-run of ffmpeg.
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** A segment after conversion and measurement. `path` null means don't upload. */
interface Prepared extends SegmentMeasurement {
  id: string;
  path: string | null;
}

/** What the prepare pass learned about one segment, minus the temporary file. */
export interface SegmentMeasurement {
  segment: AudioSegment;
  /** Why it will not be uploaded, or null if it will. */
  skipped: string | null;
  loudness: Loudness;
  /** The audio's own length, which is authoritative for a synthetic manifest. */
  audioMs: number;
}

/**
 * Runs the prepare pass alone: convert, measure, decide - and upload nothing.
 *
 * Exists so the gate can be tuned against real recordings without an API key
 * and without spending free-tier quota. Which segments get dropped as silence
 * is the judgement call in this stage most likely to be wrong, and it is much
 * easier to argue with when you can see the numbers behind each one.
 */
export async function measureSegments(
  dir: string,
  segments: readonly AudioSegment[],
): Promise<SegmentMeasurement[]> {
  const workDir = await mkdtemp(join(tmpdir(), 'meeting-scribe-'));

  try {
    return await prepare(dir, segments, workDir);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function prepare(
  dir: string,
  segments: readonly AudioSegment[],
  workDir: string,
): Promise<Prepared[]> {
  return mapWithConcurrency(segments, CONVERT_CONCURRENCY, async (segment, index) => {
    const id = String(index);
    const converted = join(workDir, `${String(index).padStart(5, '0')}.wav`);

    try {
      await toWhisperAudio(join(dir, segment.file), converted);

      const wav = await readWav(converted);
      // The manifest's duration is the truth for a real recording, but a
      // hand-built one for a lone audio file has nothing to put there.
      const durationMs = segment.durationMs > 0 ? segment.durationMs : wav.durationMs;
      const verdict = gate(wav.pcm, wav.sampleRate, durationMs);

      if (!verdict.transcribe) logSkip(segment, verdict);

      return {
        id,
        segment,
        path: verdict.transcribe ? converted : null,
        skipped: verdict.reason,
        loudness: verdict.loudness,
        audioMs: wav.durationMs,
      };
    } catch (error) {
      // A file the manifest lists but that will not convert is a capture bug,
      // not a reason to abandon the rest of the meeting.
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Could not prepare ${segment.file}`, message);

      return { id, segment, path: null, skipped: null, loudness: UNMEASURED, audioMs: 0 };
    }
  });
}

function logSkip(segment: AudioSegment, verdict: GateVerdict): void {
  log.debug(
    `Skipping ${segment.file} (${segment.displayName}): ${verdict.reason ?? 'gated'} ` +
      `[peak ${verdict.loudness.peakDbfs.toFixed(1)} dBFS, ` +
      `${Math.round(verdict.loudness.speechMs)} ms of speech]`,
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function assemble(
  manifest: MeetingManifest,
  prepared: readonly Prepared[],
  results: readonly TranscriptionResult[],
  transcriber: Transcriber,
  timing: TranscriptTiming,
): MeetingTranscript {
  const byId = new Map(results.map((result) => [result.id, result]));

  const spoken = results.filter((result) => result.error === undefined);
  const discarded = findHallucinations(spoken);

  const utterances: Utterance[] = [];
  const stats: TranscriptStats = {
    segments: manifest.segments.length,
    transcribed: 0,
    skippedQuiet: 0,
    discarded: 0,
    failed: 0,
  };

  for (const item of prepared) {
    if (item.path === null) {
      if (item.skipped === null) stats.failed += 1;
      else stats.skippedQuiet += 1;
      continue;
    }

    const result = byId.get(item.id);
    if (result === undefined || result.error !== undefined) {
      stats.failed += 1;
      continue;
    }

    const reason = discarded.get(item.id);
    if (reason !== undefined) {
      stats.discarded += 1;
      log.debug(`Discarded ${item.segment.file} (${item.segment.displayName}): ${reason}`);
      continue;
    }

    stats.transcribed += 1;
    utterances.push({
      userId: item.segment.userId,
      displayName: item.segment.displayName,
      startMs: item.segment.startMs,
      durationMs: item.segment.durationMs > 0 ? item.segment.durationMs : Math.round(item.audioMs),
      text: result.text.trim(),
    });
  }

  // Two people starting at the same millisecond is possible; keeping the order
  // stable by speaker means re-running produces an identical file.
  utterances.sort((a, b) => a.startMs - b.startMs || a.userId.localeCompare(b.userId));

  log.info(
    `Transcribed ${stats.transcribed}/${stats.segments} segments ` +
      `(${stats.skippedQuiet} too quiet, ${stats.discarded} discarded, ${stats.failed} failed) ` +
      `in ${timing.transcribeSeconds}s for ${timing.audioSeconds}s of audio ` +
      `(${timing.realtimeFactor}x realtime)`,
  );

  return {
    version: 1,
    meetingId: manifest.meetingId,
    title: manifest.title,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
    transcribedAt: new Date().toISOString(),
    provider: transcriber.name,
    model: transcriber.model,
    participants: manifest.participants,
    utterances,
    stats,
    timing,
  };
}

/**
 * Primes the model with who is in the room.
 *
 * Whisper takes this as text preceding the audio, so it biases the decoder
 * towards spelling names the way they are spelled here - which is the whole
 * point, and also why it is kept to proper nouns. A prompt containing ordinary
 * sentences is a prompt the model will happily continue when it cannot hear
 * anything.
 */
function buildPrompt(manifest: MeetingManifest, vocabulary?: string): string | undefined {
  const parts: string[] = [];

  const names = manifest.participants.map((participant) => participant.displayName).join(', ');
  if (names) parts.push(`Speakers: ${names}.`);
  if (manifest.title) parts.push(`Meeting: ${manifest.title}.`);
  if (vocabulary?.trim()) parts.push(vocabulary.trim());

  return parts.length === 0 ? undefined : parts.join(' ');
}
