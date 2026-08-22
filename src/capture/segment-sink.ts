import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { WavWriter, type WavFormat } from './wav.js';
import type { AudioSegment } from './types.js';

/**
 * Consumes the decoded PCM of a single speech burst and turns it into segment
 * files on disk.
 *
 * Input is 48 kHz stereo signed 16-bit PCM, which is what Discord's Opus
 * decodes to. Output is mono - the two channels carry the same microphone, and
 * halving the file size is free.
 *
 * Two things make this more than a `pipe()` to a file:
 *
 *  1. **Gap padding.** Discord sends no packets during short pauses, so naive
 *     concatenation silently compresses the timeline: a burst with three
 *     half-second pauses in it ends up a second and a half shorter than it
 *     really was, and every timestamp after it inside that burst is wrong.
 *     Each chunk is therefore placed against the wall clock, and missing time
 *     is filled with actual silence.
 *
 *  2. **Rollover.** A single long monologue would otherwise produce one
 *     enormous file, and hosted Whisper APIs have per-file size limits. Past
 *     MAX_SEGMENT_MS the sink closes the file and opens the next one, keeping
 *     the timeline contiguous across the split.
 */

export const SAMPLE_RATE = 48_000;
/** Discord always sends stereo, whatever the speaker's microphone is. */
export const DECODE_CHANNELS = 2;
export const OUTPUT_CHANNELS = 1;
export const OUTPUT_FORMAT: WavFormat = {
  sampleRate: SAMPLE_RATE,
  channels: OUTPUT_CHANNELS,
  bitDepth: 16,
};

const BYTES_PER_MS = (SAMPLE_RATE * OUTPUT_CHANNELS * 2) / 1000;
const STEREO_FRAME_BYTES = DECODE_CHANNELS * 2;

/**
 * Below this a "burst" is a cough, a chair, or a microphone popping as someone
 * joins - never a word. Discarded rather than written, so that a room sitting
 * in silence produces an empty audio directory.
 */
const MIN_SEGMENT_MS = 400;

/** ~11 MB as a WAV. Comfortably under every hosted transcription size limit. */
const MAX_SEGMENT_MS = 120_000;
const MAX_SEGMENT_BYTES = MAX_SEGMENT_MS * BYTES_PER_MS;

/**
 * How far behind the wall clock a chunk may fall before we call it a real gap
 * rather than network jitter. Discord frames are 20 ms and arrive bunched, so
 * this has to absorb several frames' worth of lateness; it sits below the 1 s
 * silence window that ends a burst, so every gap this could miss is one that
 * would have ended the burst anyway.
 */
const GAP_TOLERANCE_MS = 120;

/** Ceiling on a single padding write. See #padToWallClock for why. */
const MAX_PAD_MS = 2_000;

export interface SegmentSinkOptions {
  /** Absolute path of the meeting directory. Segment paths are relative to it. */
  meetingDir: string;
  userId: string;
  /** Offset from the start of the meeting at which this burst began. */
  startMs: number;
  /** Resolved lazily: the name lookup is usually still in flight when we start. */
  displayName: () => Promise<string>;
}

export class SegmentSink extends Writable {
  /** Completed segments, in the order they were written. */
  readonly segments: AudioSegment[] = [];

  readonly #options: SegmentSinkOptions;
  readonly #startedAt = Date.now();

  /**
   * The *promise* of a writer, not the writer, and assigned synchronously.
   *
   * Holding the resolved value instead leaves a window - the length of an
   * fs.open - in which a file is being created but is invisible to
   * #closeFile. A destroy arriving in that window finds nothing to close,
   * returns, and the create then resolves into a file that is written to and
   * never closed: 44 bytes of unpatched header and orphaned audio.
   */
  #writer: Promise<WavWriter> | null = null;
  /** Set once this sink is finished with, so late writes cannot reopen a file. */
  #closed = false;
  #file = '';
  #fileStartMs = 0;
  /** Audio written across every file of this burst, padding included. */
  #producedBytes = 0;
  /** Partial stereo frame carried over between chunks. */
  #remainder: Buffer = Buffer.alloc(0);

  constructor(options: SegmentSinkOptions) {
    super({ decodeStrings: false });
    this.#options = options;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error) => void): void {
    this.#consume(chunk).then(() => done(), done);
  }

  override _final(done: (error?: Error) => void): void {
    this.#closed = true;
    this.#closeFile().then(() => done(), done);
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    // Reached on a mid-burst failure, and it can arrive while a _write is
    // still in flight. Close the file anyway rather than abandoning an
    // unpatched header: a partial segment still transcribes.
    this.#closed = true;
    this.#closeFile().then(
      () => done(error),
      () => done(error),
    );
  }

  async #consume(chunk: Buffer): Promise<void> {
    const stereo = this.#remainder.length > 0 ? Buffer.concat([this.#remainder, chunk]) : chunk;
    const usable = stereo.length - (stereo.length % STEREO_FRAME_BYTES);
    this.#remainder = stereo.subarray(usable);

    if (usable === 0) return;

    const mono = downmix(stereo.subarray(0, usable));
    await this.#padToWallClock(mono.length / BYTES_PER_MS);
    await this.#append(mono);
  }

  /**
   * A chunk arriving now represents the `chunkMs` of audio that just finished,
   * so it belongs at (elapsed - chunkMs). Anything between there and what we
   * have already written is time Discord never sent us: fill it with silence.
   */
  async #padToWallClock(chunkMs: number): Promise<void> {
    const elapsedMs = Date.now() - this.#startedAt;
    const gapMs = elapsedMs - chunkMs - this.#producedBytes / BYTES_PER_MS;

    if (gapMs <= GAP_TOLERANCE_MS) return;

    // A gap longer than the silence window should have ended the burst
    // entirely, so anything bigger is a stalled event loop, not a pause.
    // Capping keeps one bad moment from writing minutes of silence.
    const padMs = Math.min(Math.round(gapMs), MAX_PAD_MS);
    await this.#append(Buffer.alloc(padMs * BYTES_PER_MS));
  }

  /** Writes mono PCM, rolling over to a new file when the current one is full. */
  async #append(pcm: Buffer): Promise<void> {
    let offset = 0;

    while (offset < pcm.length) {
      if (this.#closed) return;

      const writer = await this.#openFile();

      // Checked again: a destroy can land while the file is being opened, and
      // #closeFile will already have closed this very writer.
      if (this.#closed) return;

      const room = MAX_SEGMENT_BYTES - writer.dataBytes;
      const take = Math.min(room, pcm.length - offset);

      await writer.write(pcm.subarray(offset, offset + take));
      this.#producedBytes += take;
      offset += take;

      if (writer.dataBytes >= MAX_SEGMENT_BYTES) await this.#closeFile();
    }
  }

  #openFile(): Promise<WavWriter> {
    if (this.#writer) return this.#writer;

    // Where this file sits in the meeting = where the burst started, plus
    // everything already written for it. Rollovers stay contiguous.
    this.#fileStartMs = this.#options.startMs + Math.round(this.#producedBytes / BYTES_PER_MS);

    // Naming by start offset makes `ls` a timeline and makes a collision
    // impossible: one speaker cannot start two bursts at the same millisecond.
    const name = `${String(this.#fileStartMs).padStart(8, '0')}-${this.#options.userId}.wav`;
    this.#file = join('audio', name);

    // Stored, not awaited - see the field declaration.
    this.#writer = WavWriter.create(join(this.#options.meetingDir, this.#file), OUTPUT_FORMAT);
    return this.#writer;
  }

  async #closeFile(): Promise<void> {
    const pending = this.#writer;
    if (!pending) return;

    // Cleared first so this stays a no-op if _final and _destroy both run.
    this.#writer = null;

    // Awaits an open that may still be in flight, which is the whole point of
    // storing the promise.
    const writer = await pending;
    const durationMs = Math.round((await writer.close()) / BYTES_PER_MS);

    if (durationMs < MIN_SEGMENT_MS) {
      await unlink(join(this.#options.meetingDir, this.#file)).catch(() => {});
      return;
    }

    this.segments.push({
      file: this.#file,
      userId: this.#options.userId,
      displayName: await this.#options.displayName(),
      startMs: this.#fileStartMs,
      durationMs,
    });
  }
}

/**
 * Stereo signed 16-bit LE to mono, by averaging. `>> 1` rather than `/ 2`
 * because the sum of two int16s is exactly representable and an arithmetic
 * shift keeps the result in range without a rounding step.
 */
function downmix(stereo: Buffer): Buffer {
  const frames = stereo.length / STEREO_FRAME_BYTES;
  const mono = Buffer.alloc(frames * 2);

  for (let frame = 0; frame < frames; frame += 1) {
    const left = stereo.readInt16LE(frame * STEREO_FRAME_BYTES);
    const right = stereo.readInt16LE(frame * STEREO_FRAME_BYTES + 2);
    mono.writeInt16LE((left + right) >> 1, frame * 2);
  }

  return mono;
}
