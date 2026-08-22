import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';

/**
 * The format-conversion and measurement mechanics this stage needs. No policy
 * lives here - what counts as too quiet to bother with is `gate.ts`.
 *
 * Capture deliberately writes lossless 48 kHz WAV and converts nothing, so
 * this is where the provider's preferences get satisfied. Whisper resamples
 * everything to 16 kHz mono internally, which means uploading 48 kHz stereo is
 * three times the bytes for identical output.
 */

const execFileAsync = promisify(execFile);

/** What Whisper works at internally. Anything else is bytes we pay to upload. */
export const WHISPER_SAMPLE_RATE = 16_000;

/** Signed 16-bit PCM, so full scale is 2^15. */
const FULL_SCALE = 32_768;

/** Loudness is measured over windows this long. One Discord frame. */
const WINDOW_MS = 20;

/**
 * Converts any audio ffmpeg can read into 16 kHz mono 16-bit WAV.
 *
 * WAV rather than FLAC because this stage reads the samples back to measure
 * them, and parsing our own output beats shelling out a second time. The size
 * win from FLAC would be real but buys no capability: a two-minute segment is
 * under 4 MB either way, comfortably inside every hosted size limit.
 */
export async function toWhisperAudio(source: string, target: string): Promise<void> {
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel', 'error',
        // Without this ffmpeg can try to read the terminal and hang forever
        // when several run at once.
        '-nostdin',
        '-y',
        '-i', source,
        '-ac', '1',
        '-ar', String(WHISPER_SAMPLE_RATE),
        '-c:a', 'pcm_s16le',
        '-f', 'wav',
        target,
      ],
      { maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(
        'ffmpeg is not installed or not on PATH. It is in the Docker image; ' +
          'for local runs install it (apt install ffmpeg / brew install ffmpeg).',
      );
    }
    throw new Error(`ffmpeg could not convert ${basename(source)}: ${describe(error)}`);
  }
}

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  durationMs: number;
  /** Interleaved signed 16-bit little-endian samples. */
  pcm: Buffer;
}

/**
 * Reads a 16-bit PCM WAV into memory.
 *
 * Walks the chunk list rather than assuming the 44-byte header `wav.ts`
 * writes: ffmpeg puts a LIST chunk of its own between `fmt ` and `data`, and
 * skipping a fixed 44 bytes would read that as audio.
 */
export async function readWav(path: string): Promise<DecodedWav> {
  const file = await readFile(path);

  if (
    file.length < 12 ||
    file.toString('ascii', 0, 4) !== 'RIFF' ||
    file.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error(`Not a RIFF/WAVE file: ${path}`);
  }

  let sampleRate = 0;
  let channels = 0;
  let bitDepth = 0;
  let pcm: Buffer | null = null;

  let offset = 12;
  while (offset + 8 <= file.length) {
    const id = file.toString('ascii', offset, offset + 4);
    const declared = file.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ' && declared >= 16) {
      channels = file.readUInt16LE(body + 2);
      sampleRate = file.readUInt32LE(body + 4);
      bitDepth = file.readUInt16LE(body + 14);
    } else if (id === 'data') {
      // A recording interrupted mid-burst never got its length patched in, so
      // a zero here means "the rest of the file", not "no audio".
      const available = file.length - body;
      pcm = file.subarray(body, body + (declared === 0 ? available : Math.min(declared, available)));
      break;
    }

    // Chunks are word-aligned: an odd length is followed by a pad byte.
    offset = body + declared + (declared % 2);
  }

  if (pcm === null || sampleRate === 0 || channels === 0) {
    throw new Error(`WAV file is missing a fmt or data chunk: ${path}`);
  }
  if (bitDepth !== 16) {
    throw new Error(`Expected 16-bit PCM, got ${bitDepth}-bit: ${path}`);
  }

  const frames = Math.floor(pcm.length / 2 / channels);

  return { sampleRate, channels, durationMs: (frames * 1000) / sampleRate, pcm };
}

export interface Loudness {
  /** The loudest single sample, in dBFS. -Infinity for digital silence. */
  peakDbfs: number;
  /** Milliseconds of audio whose short-window RMS clears `windowFloorDbfs`. */
  speechMs: number;
  /**
   * RMS across those windows only, in dBFS. Measured over the loud parts alone
   * so that the silence `SegmentSink` pads gaps with - and the pauses inside
   * any real sentence - do not drag a perfectly audible burst below the floor.
   */
  speechDbfs: number;
}

/** Mono 16-bit PCM in, three numbers out. Caller supplies the noise floor. */
export function measureLoudness(pcm: Buffer, sampleRate: number, windowFloorDbfs: number): Loudness {
  const samples = Math.floor(pcm.length / 2);
  const windowSamples = Math.max(1, Math.round((sampleRate * WINDOW_MS) / 1000));

  let peak = 0;
  for (let i = 0; i < samples; i += 1) {
    const magnitude = Math.abs(pcm.readInt16LE(i * 2));
    if (magnitude > peak) peak = magnitude;
  }

  let activeSamples = 0;
  let activeEnergy = 0;

  for (let start = 0; start + windowSamples <= samples; start += windowSamples) {
    let sumSquares = 0;
    for (let i = start; i < start + windowSamples; i += 1) {
      const sample = pcm.readInt16LE(i * 2);
      sumSquares += sample * sample;
    }

    if (dbfs(Math.sqrt(sumSquares / windowSamples)) < windowFloorDbfs) continue;

    activeSamples += windowSamples;
    activeEnergy += sumSquares;
  }

  return {
    peakDbfs: dbfs(peak),
    speechMs: (activeSamples * 1000) / sampleRate,
    speechDbfs: activeSamples === 0 ? -Infinity : dbfs(Math.sqrt(activeEnergy / activeSamples)),
  };
}

/** Amplitude (0..32768) to decibels relative to full scale. */
function dbfs(amplitude: number): number {
  return amplitude <= 0 ? -Infinity : 20 * Math.log10(amplitude / FULL_SCALE);
}

/** dBFS for humans: `-23.4 dBFS`, or `silent` for -Infinity. */
export function formatDbfs(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)} dBFS` : 'silent';
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function describe(error: unknown): string {
  const stderr = (error as { stderr?: string } | null)?.stderr?.trim();
  if (stderr) return stderr.split('\n').slice(-3).join('; ');
  return error instanceof Error ? error.message : String(error);
}
