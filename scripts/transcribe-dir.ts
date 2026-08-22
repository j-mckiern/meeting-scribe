import { stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { readManifest } from '../src/capture/manifest.js';
import type { MeetingManifest } from '../src/capture/types.js';
import { config } from '../src/config.js';
import { formatDbfs } from '../src/transcribe/audio.js';
import { GroqTranscriber } from '../src/transcribe/groq.js';
import { LocalWhisperTranscriber } from '../src/transcribe/local.js';
import {
  measureSegments,
  transcribeMeeting,
  transcribeSegments,
  type SegmentMeasurement,
} from '../src/transcribe/index.js';
import { transcriptPath } from '../src/transcribe/transcript.js';
import type { MeetingTranscript, Transcriber } from '../src/transcribe/types.js';
import { formatClock } from '../src/util/time.js';

/**
 * Runs the transcription stage on its own.
 *
 *   npm run transcribe -- data/meetings/<meetingId>   # writes transcript.json
 *   npm run transcribe -- ~/Downloads/podcast.mp3     # prints only
 *   npm run transcribe -- <either> --gate-only        # measure, upload nothing
 *   npm run transcribe -- <either> --groq             # override TRANSCRIBER
 *
 * Pointing it at a single audio file is how a Whisper problem gets told apart
 * from a capture problem: a clean recording of people talking is either
 * transcribed well or it is not, and the answer does not involve Discord.
 * That path deliberately passes no vocabulary prompt, so what comes back is
 * the model unaided.
 *
 * `--gate-only` runs the measurement pass and stops, which is the cheap way to
 * argue with the energy gate - no API key, no quota, just the numbers behind
 * every keep-or-drop decision.
 */

const WRAP_COLUMNS = 88;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const gateOnly = args.includes('--gate-only');
  const provider = args.includes('--groq') ? 'groq' : args.includes('--local') ? 'local' : undefined;
  const target = args.find((arg) => !arg.startsWith('--'));

  if (!target) {
    console.error('Usage: npm run transcribe -- <meetingDir | audioFile> [--gate-only]');
    process.exit(1);
  }

  const path = resolve(target);
  const isDirectory = (await stat(path)).isDirectory();

  const dir = isDirectory ? path : dirname(path);
  const manifest = isDirectory ? await readManifest(path) : singleFileManifest(basename(path));

  if (gateOnly) {
    printGate(await measureSegments(dir, manifest.segments));
    return;
  }

  const transcriber = buildTranscriber(provider ?? config.TRANSCRIBER);

  if (isDirectory) {
    // The vocabulary prompt only makes sense for a real meeting - it is the
    // team's own names and jargon.
    const transcript = await transcribeMeeting(dir, {
      transcriber,
      vocabulary: config.TRANSCRIPTION_VOCABULARY,
    });

    printTranscript(transcript);
    console.log(`Written to ${transcriptPath(dir)}\n`);
  } else {
    printTranscript(await transcribeSegments(dir, manifest, { transcriber }));
    console.log('Nothing written - a lone audio file is not a meeting.\n');
  }
}

function buildTranscriber(provider: 'local' | 'groq'): Transcriber {
  const language =
    config.TRANSCRIPTION_LANGUAGE === 'auto' ? undefined : config.TRANSCRIPTION_LANGUAGE;

  if (provider === 'groq') {
    return new GroqTranscriber({
      apiKey: config.GROQ_API_KEY,
      model: config.GROQ_MODEL,
      language,
      concurrency: config.TRANSCRIBE_CONCURRENCY,
    });
  }

  return new LocalWhisperTranscriber({
    python: config.WHISPER_PYTHON,
    model: config.WHISPER_MODEL,
    device: config.WHISPER_DEVICE,
    computeType: config.WHISPER_COMPUTE_TYPE,
    language,
  });
}

/**
 * A manifest invented for one file on disk, so the same code path runs against
 * a podcast clip. No title and no participants, which leaves the vocabulary
 * prompt empty - the point of this path is an unbiased baseline.
 */
function singleFileManifest(file: string): MeetingManifest {
  return {
    version: 1,
    meetingId: file,
    guildId: '',
    voiceChannelId: '',
    title: null,
    startedBy: '',
    startedAt: new Date().toISOString(),
    endedAt: null,
    // Unknown, and unread: this stage takes the real format from ffmpeg.
    audio: { container: 'wav', encoding: 'pcm_s16le', sampleRate: 0, channels: 0 },
    participants: [],
    segments: [{ file, userId: 'file', displayName: 'Recording', startMs: 0, durationMs: 0 }],
  };
}

function printTranscript(transcript: MeetingTranscript): void {
  const { stats } = transcript;

  console.log(`\nTranscript  ${transcript.meetingId}`);
  console.log(`Provider    ${transcript.provider}/${transcript.model}`);
  console.log(`Speakers    ${describeSpeakers(transcript)}`);

  console.log('\nUtterances');

  if (transcript.utterances.length === 0) {
    console.log('  (nothing was transcribed)');
  }

  const width = Math.max(1, ...transcript.utterances.map((u) => u.displayName.length));

  for (const utterance of transcript.utterances) {
    const label = `  [${formatClock(utterance.startMs)}]  ${utterance.displayName.padEnd(width)}  `;
    console.log(label + wrap(utterance.text, label.length));
  }

  const { timing } = transcript;
  console.log('\nTiming');
  console.log(
    `  ${timing.transcribeSeconds}s for ${timing.audioSeconds}s of audio  ` +
      `-> ${timing.realtimeFactor}x realtime  (prepare ${timing.prepareSeconds}s)`,
  );

  console.log('\nSegments');
  console.log(
    `  ${stats.segments} listed: ${stats.transcribed} transcribed, ` +
      `${stats.skippedQuiet} too quiet, ${stats.discarded} discarded, ${stats.failed} failed`,
  );

  // A meeting where most of the audio was thrown away is not obviously broken
  // from the timeline alone, so say it plainly.
  const dropped = stats.skippedQuiet + stats.discarded + stats.failed;
  if (stats.segments > 0 && dropped > stats.segments / 2) {
    console.log('  WARN  more than half the segments produced nothing. Try --gate-only.');
  }

  console.log();
}

function describeSpeakers(transcript: MeetingTranscript): string {
  const spoke = new Set(transcript.utterances.map((utterance) => utterance.displayName));

  if (transcript.participants.length === 0) return spoke.size === 0 ? '(none)' : [...spoke].join(', ');

  return transcript.participants
    .map((p) => (spoke.has(p.displayName) ? p.displayName : `${p.displayName} (nothing kept)`))
    .join(', ');
}

function printGate(measurements: readonly SegmentMeasurement[]): void {
  console.log('\nGate');

  if (measurements.length === 0) {
    console.log('  (no segments)');
    return;
  }

  const width = Math.max(...measurements.map((m) => m.segment.displayName.length));
  let passed = 0;

  for (const { segment, skipped, loudness, audioMs } of measurements) {
    if (skipped === null) passed += 1;

    // audioMs when the manifest has no duration to give - the single-file path.
    const durationMs = segment.durationMs > 0 ? segment.durationMs : audioMs;

    console.log(
      `  [${formatClock(segment.startMs)}]  ${segment.displayName.padEnd(width)}  ` +
        `${(durationMs / 1000).toFixed(1).padStart(6)}s  ` +
        `peak ${formatDbfs(loudness.peakDbfs).padStart(11)}  ` +
        `speech ${formatDbfs(loudness.speechDbfs).padStart(11)} ` +
        `for ${String(Math.round(loudness.speechMs)).padStart(6)} ms  ` +
        (skipped === null ? 'PASS' : `SKIP  ${skipped}`),
    );
  }

  console.log(`\n  ${passed}/${measurements.length} segments would be uploaded\n`);
}

/** Wraps text to the terminal, hanging-indented under the speaker's name. */
function wrap(text: string, indent: number): string {
  const width = Math.max(30, WRAP_COLUMNS - indent);
  const lines: string[] = [];
  let line = '';

  for (const word of text.split(/\s+/)) {
    if (line.length > 0 && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) lines.push(line);

  return lines.join(`\n${' '.repeat(indent)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
