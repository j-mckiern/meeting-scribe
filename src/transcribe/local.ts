import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { log } from '../logger.js';
import { aggregateQuality, type QualityWindow } from './quality.js';
import type { Transcriber, TranscriptionJob, TranscriptionResult } from './types.js';

/**
 * Whisper running on this machine, via faster-whisper in a Python worker.
 *
 * Nothing leaves the host. That is the entire point of this provider: the
 * audio being transcribed is a recording of people who agreed to be in a
 * meeting, not to be uploaded to an inference vendor.
 *
 * One worker process per batch, not per file. Loading the model takes roughly
 * seven times as long as transcribing ten seconds of audio with it, so a
 * per-file process would spend nearly all of its time loading. This is what
 * the batch-in/batch-out `Transcriber` interface was shaped for.
 *
 * Results stream back as each file finishes rather than arriving all at once,
 * because on CPU a real meeting takes minutes and silent progress for minutes
 * is indistinguishable from a hang.
 */

/**
 * Two levels up lands on the project root from `src/transcribe/` and from
 * `dist/transcribe/` alike, so this resolves the same under tsx and under the
 * compiled build.
 */
const WORKER_PATH = fileURLToPath(new URL('../../scripts/whisper_worker.py', import.meta.url));

export const DEFAULT_WHISPER_MODEL = 'deepdml/faster-whisper-large-v3-turbo-ct2';

export interface LocalWhisperOptions {
  /** Interpreter with faster-whisper installed. */
  python: string;
  model?: string;
  /** `cpu`, `cuda`, or `auto`. */
  device?: string;
  /** `int8` on CPU, `float16` on a GPU. `auto` lets faster-whisper choose. */
  computeType?: string;
  language?: string;
}

export class LocalWhisperTranscriber implements Transcriber {
  readonly name = 'faster-whisper';
  readonly model: string;

  readonly #python: string;
  readonly #device: string;
  readonly #computeType: string;
  readonly #language: string | undefined;

  constructor(options: LocalWhisperOptions) {
    this.model = options.model ?? DEFAULT_WHISPER_MODEL;
    this.#python = options.python;
    this.#device = options.device ?? 'auto';
    this.#computeType = options.computeType ?? 'auto';
    this.#language = options.language;
  }

  async transcribe(jobs: readonly TranscriptionJob[]): Promise<TranscriptionResult[]> {
    if (jobs.length === 0) return [];

    const config = {
      model: this.model,
      device: this.#device,
      computeType: this.#computeType,
      language: this.#language ?? null,
    };

    const child = spawn(this.#python, [WORKER_PATH, JSON.stringify(config)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const results = new Map<string, TranscriptionResult>();
    let fatal: string | null = null;
    let finished = 0;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // faster-whisper logs model downloads and warnings here. Useful the
      // first time a model is pulled, noise afterwards.
      for (const line of chunk.split('\n')) {
        if (line.trim()) log.debug(`whisper: ${line.trim()}`);
      }
    });

    const settled = new Promise<void>((resolve, reject) => {
      createInterface({ input: child.stdout }).on('line', (line: string) => {
        if (!line.trim()) return;

        let message: WorkerMessage;
        try {
          message = JSON.parse(line) as WorkerMessage;
        } catch {
          log.warn(`Unparseable line from the whisper worker: ${line.slice(0, 200)}`);
          return;
        }

        if (message.event === 'ready') {
          log.info(`Whisper model loaded in ${message.loadSeconds ?? '?'}s (${this.model})`);
          return;
        }

        if (message.event === 'fatal') {
          fatal = message.error ?? 'the whisper worker failed to start';
          return;
        }

        if (message.event !== 'result' || message.id === undefined) return;

        finished += 1;
        log.debug(`Transcribed ${finished}/${jobs.length}`);
        results.set(message.id, toResult(message));
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
        reject(
          error.code === 'ENOENT'
            ? new Error(
                `No Python interpreter at ${this.#python}. Create one with: ` +
                  'uv venv .venv-whisper && uv pip install --python .venv-whisper faster-whisper',
              )
            : error,
        );
      });

      child.on('close', (code) => {
        if (fatal !== null) reject(new Error(fatal));
        else if (code !== 0) reject(new Error(`The whisper worker exited with code ${code}`));
        else resolve();
      });
    });

    for (const job of jobs) {
      child.stdin.write(
        `${JSON.stringify({ id: job.id, path: job.path, prompt: job.prompt ?? null })}\n`,
      );
    }
    child.stdin.end();

    await settled;

    // A job the worker never answered for is a bug, not a transcription
    // failure - but it still belongs in this segment's result rather than
    // taking the meeting down with it.
    return jobs.map(
      (job) =>
        results.get(job.id) ?? {
          id: job.id,
          text: '',
          quality: null,
          error: `the whisper worker returned nothing for ${basename(job.path)}`,
        },
    );
  }
}

interface WorkerMessage {
  event: 'ready' | 'result' | 'fatal';
  id?: string;
  text?: string;
  windows?: QualityWindow[];
  error?: string;
  loadSeconds?: number;
}

function toResult(message: WorkerMessage): TranscriptionResult {
  const id = message.id ?? '';

  if (message.error !== undefined) {
    return { id, text: '', quality: null, error: message.error };
  }

  return {
    id,
    text: (message.text ?? '').trim(),
    quality: aggregateQuality(message.windows ?? []),
  };
}
