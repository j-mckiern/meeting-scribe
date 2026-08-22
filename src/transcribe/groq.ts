import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { log } from '../logger.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { aggregateQuality } from './quality.js';
import type { Transcriber, TranscriptionJob, TranscriptionResult } from './types.js';

/**
 * Whisper on Groq's free tier, via their OpenAI-compatible audio endpoint.
 *
 * The interface is batch-in/batch-out, so choosing how many requests to have
 * in flight is this file's job. The free tier is rate limited per minute and
 * per hour of audio, which makes a 429 an ordinary event rather than an error
 * - it comes back with a `retry-after` and is worth honouring exactly.
 *
 * A rejected key, by contrast, is not worth retrying two hundred times. That
 * is the one failure that aborts the whole batch instead of landing in a
 * single result.
 */

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

export const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo';

/** Free tier allows ~20 requests a minute; three at a time leaves headroom. */
const DEFAULT_CONCURRENCY = 3;

const DEFAULT_MAX_ATTEMPTS = 4;

/** Ceiling on any single wait, including one the server asked for. */
const MAX_BACKOFF_MS = 60_000;

/** Generous: a two-minute segment on a slow uplink is still well inside this. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Whisper accepts about 224 tokens of prompt; this is that, roughly, in characters. */
const MAX_PROMPT_CHARS = 800;

export interface GroqTranscriberOptions {
  apiKey: string | undefined;
  model?: string;
  /** ISO-639-1 code. Leave undefined to let the model detect it per segment. */
  language?: string;
  concurrency?: number;
  maxAttempts?: number;
}

/** Thrown when retrying anything would be pointless. Aborts the batch. */
export class TranscriptionAuthError extends Error {}

export class GroqTranscriber implements Transcriber {
  readonly name = 'groq';
  readonly model: string;

  readonly #apiKey: string;
  readonly #language: string | undefined;
  readonly #concurrency: number;
  readonly #maxAttempts: number;

  constructor(options: GroqTranscriberOptions) {
    // A point-of-use check rather than a boot-time one: the bot runs fine
    // without a transcription key right up until someone stops a meeting, and
    // a config error at that moment should name the variable it needs.
    if (!options.apiKey) {
      throw new Error(
        'GROQ_API_KEY is not set. Get one from console.groq.com -> API Keys and put it in .env.',
      );
    }

    this.#apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_GROQ_MODEL;
    this.#language = options.language;
    this.#concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async transcribe(jobs: readonly TranscriptionJob[]): Promise<TranscriptionResult[]> {
    return mapWithConcurrency(jobs, this.#concurrency, async (job) => {
      try {
        return await this.#send(job);
      } catch (error) {
        // One unreadable file or one segment the API choked on should cost that
        // segment, not the meeting.
        if (error instanceof TranscriptionAuthError) throw error;

        const message = error instanceof Error ? error.message : String(error);
        log.warn(`Transcription failed for ${basename(job.path)}`, message);
        return { id: job.id, text: '', quality: null, error: message };
      }
    });
  }

  async #send(job: TranscriptionJob): Promise<TranscriptionResult> {
    // A Blob backed by the file rather than a Buffer of it: a two-minute
    // segment is a few megabytes, and with several requests in flight there is
    // no reason for all of them to sit in memory at once.
    const audio = await openAsBlob(job.path);

    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#apiKey}` },
        body: this.#buildForm(audio, job),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.ok) {
        return toResult(job.id, (await response.json()) as GroqVerboseResponse);
      }

      const body = (await response.text().catch(() => '')).trim();

      if (response.status === 401 || response.status === 403) {
        throw new TranscriptionAuthError(
          `Groq rejected the API key (HTTP ${response.status}). Check GROQ_API_KEY in .env.`,
        );
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= this.#maxAttempts) {
        throw new Error(`Groq returned HTTP ${response.status}: ${firstLine(body)}`);
      }

      const waitMs = backoffMs(response, attempt);
      log.debug(
        `Groq HTTP ${response.status} on ${basename(job.path)}; ` +
          `retrying in ${Math.round(waitMs / 100) / 10}s (attempt ${attempt}/${this.#maxAttempts})`,
      );
      await sleep(waitMs);
    }
  }

  /**
   * Rebuilt per attempt rather than hoisted: a FormData becomes a one-shot
   * request body once fetch has consumed it, and reusing it after a 429 sends
   * an empty request. The Blob inside it re-reads the file each time, so only
   * the wrapper is rebuilt.
   */
  #buildForm(audio: Blob, job: TranscriptionJob): FormData {
    const form = new FormData();

    form.append('file', audio, basename(job.path));
    form.append('model', this.model);
    // verbose_json is the only response format that carries the per-window
    // confidence numbers `hallucinations.ts` needs.
    form.append('response_format', 'verbose_json');
    // Deterministic, and far less inclined to invent words for audio it cannot
    // make out - which is exactly the failure mode this stage is fighting.
    form.append('temperature', '0');

    // Pinning the language stops the model "detecting" Welsh from three
    // seconds of a noisy microphone and translating the rest of the burst.
    if (this.#language) form.append('language', this.#language);
    if (job.prompt) form.append('prompt', job.prompt.slice(0, MAX_PROMPT_CHARS));

    return form;
  }
}

/** Only the fields we use; Groq returns a good deal more. */
interface GroqVerboseResponse {
  text?: string;
  segments?: {
    start?: number;
    end?: number;
    avg_logprob?: number;
    compression_ratio?: number;
    no_speech_prob?: number;
  }[];
}

function toResult(id: string, payload: GroqVerboseResponse): TranscriptionResult {
  const text = (payload.text ?? '').trim();

  const quality = aggregateQuality(
    (payload.segments ?? []).map((window) => ({
      start: window.start,
      end: window.end,
      avgLogProb: window.avg_logprob,
      noSpeechProb: window.no_speech_prob,
      compressionRatio: window.compression_ratio,
    })),
  );

  return { id, text, quality };
}

/**
 * How long to wait before the next attempt. A `retry-after` is the server
 * telling us exactly when its window reopens, so prefer it over guessing;
 * fall back to exponential backoff when it is absent or nonsense.
 */
function backoffMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }

  return Math.min(2 ** attempt * 500, MAX_BACKOFF_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Error bodies can be a page of JSON; the first line is the useful part. */
function firstLine(body: string): string {
  return body.split('\n', 1)[0]?.slice(0, 300) ?? '(empty response)';
}
