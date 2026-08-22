import { open, type FileHandle } from 'node:fs/promises';

/**
 * A minimal streaming WAV writer.
 *
 * WAV puts two byte counts in a header at the front of the file, and we do not
 * know either until the speaker stops talking. So: write a placeholder header,
 * append samples as they arrive, then seek back and patch the two fields on
 * close. That is the whole trick, and it is why this is a class rather than a
 * function.
 *
 * WAV rather than a compressed format because capture should not be in the
 * business of lossy re-encoding - the transcription step owns whatever format
 * conversion its provider needs.
 */

const HEADER_BYTES = 44;

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitDepth: 16;
}

export class WavWriter {
  readonly #handle: FileHandle;
  readonly #format: WavFormat;
  #dataBytes = 0;

  private constructor(handle: FileHandle, format: WavFormat) {
    this.#handle = handle;
    this.#format = format;
  }

  static async create(path: string, format: WavFormat): Promise<WavWriter> {
    const handle = await open(path, 'w');
    const writer = new WavWriter(handle, format);
    await handle.write(buildHeader(format, 0), 0, HEADER_BYTES, 0);
    return writer;
  }

  /** Bytes of audio written so far, excluding the header. */
  get dataBytes(): number {
    return this.#dataBytes;
  }

  async write(pcm: Buffer): Promise<void> {
    if (pcm.length === 0) return;

    // Always write at an explicit offset. Mixing positioned and unpositioned
    // writes on one handle is exactly the kind of thing that works until the
    // header patch below moves the file pointer.
    await this.#handle.write(pcm, 0, pcm.length, HEADER_BYTES + this.#dataBytes);
    this.#dataBytes += pcm.length;
  }

  /** Patches the length fields and closes. Returns the bytes of audio written. */
  async close(): Promise<number> {
    try {
      await this.#handle.write(buildHeader(this.#format, this.#dataBytes), 0, HEADER_BYTES, 0);
    } finally {
      await this.#handle.close();
    }
    return this.#dataBytes;
  }
}

function buildHeader(format: WavFormat, dataBytes: number): Buffer {
  const { sampleRate, channels, bitDepth } = format;
  const blockAlign = (channels * bitDepth) / 8;

  const header = Buffer.alloc(HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4); // everything after this field
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk length, 16 for uncompressed PCM
  header.writeUInt16LE(1, 20); // 1 = PCM, no compression
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
