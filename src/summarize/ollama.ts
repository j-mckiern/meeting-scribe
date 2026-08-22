import { log } from '../logger.js';
import type { CompletionRequest, Summarizer } from './types.js';

/**
 * A local model via Ollama.
 *
 * Ollama compiles the JSON Schema into a decoding grammar, so malformed JSON
 * is not merely unlikely but unrepresentable - the model physically cannot
 * emit a token that would break the structure. That is a stronger guarantee
 * than any hosted structured-output mode gives, and it is what makes a 4B
 * model viable here at all. What it does not guarantee is that the *content*
 * is right, which is what the repair loop upstream is for.
 */

/** Ollama's default port. Point this at another machine to borrow its GPU. */
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

export const DEFAULT_SUMMARY_MODEL = 'qwen3:4b';

/** Generous: a long transcript on a CPU-only box is genuinely slow. */
const REQUEST_TIMEOUT_MS = 900_000;

export interface OllamaSummarizerOptions {
  baseUrl?: string;
  model?: string;
  /** Transcript plus prompt plus output, in tokens. Costs RAM on CPU. */
  contextTokens?: number;
}

export class OllamaSummarizer implements Summarizer {
  readonly name = 'ollama';
  readonly model: string;

  readonly #baseUrl: string;
  readonly #contextTokens: number;

  constructor(options: OllamaSummarizerOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
    this.model = options.model ?? DEFAULT_SUMMARY_MODEL;
    this.#contextTokens = options.contextTokens ?? 8192;
  }

  async complete(request: CompletionRequest): Promise<string> {
    const started = Date.now();

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          // Reasoning models emit a thinking block that competes with the
          // grammar and costs minutes on CPU for no benefit here: the schema
          // already dictates the shape, and the transcript is the only source.
          think: false,
          format: request.schema,
          options: {
            temperature: request.temperature ?? 0.2,
            num_ctx: this.#contextTokens,
          },
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        }),
      });
    } catch (error) {
      throw new Error(
        `Could not reach Ollama at ${this.#baseUrl}. Is it running? ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }

    if (!response.ok) {
      const body = (await response.text().catch(() => '')).trim().slice(0, 300);

      // The most common failure by far, and the message Ollama gives for it is
      // not obviously actionable.
      if (response.status === 404) {
        throw new Error(
          `Ollama has no model named "${this.model}". Pull it with: ollama pull ${this.model}`,
        );
      }

      throw new Error(`Ollama returned HTTP ${response.status}: ${body}`);
    }

    const body = (await response.json()) as { message?: { content?: string } };
    const content = body.message?.content ?? '';

    log.debug(
      `Ollama ${this.model} answered in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
        `(${content.length} chars)`,
    );

    return content;
  }
}
