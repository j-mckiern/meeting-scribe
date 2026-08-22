/**
 * The summarisation backend, kept deliberately thin.
 *
 * A provider's whole job is "given a system prompt, a user prompt and a JSON
 * Schema, return text that satisfies the schema". It does not know what a
 * meeting is, and it does not validate - validation belongs to the caller,
 * because the repair loop needs the validation error in order to re-prompt
 * with it.
 *
 * Returning raw text rather than a parsed object is the point: a model that
 * returns something unparseable is a case the pipeline has to handle, and an
 * interface that promises a parsed object has nowhere to put that.
 */

export interface CompletionRequest {
  system: string;
  user: string;
  /** JSON Schema the provider constrains its output to. */
  schema: Record<string, unknown>;
  /** Raised on a repair attempt: the model needs room to correct itself. */
  temperature?: number;
}

export interface Summarizer {
  /** Short identifier recorded in the summary, e.g. `ollama`. */
  readonly name: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<string>;
}
