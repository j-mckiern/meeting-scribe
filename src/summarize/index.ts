import type { z } from 'zod';
import { log } from '../logger.js';
import type { MeetingTranscript } from '../transcribe/types.js';
import { buildRepairPrompt, buildSystemPrompt, buildUserPrompt } from './prompt.js';
import {
  buildSummarySchema,
  emptySummary,
  summaryJsonSchema,
  type MeetingSummary,
  type SummarySchema,
} from './schema.js';
import { writeSummary, type MeetingSummaryDocument } from './summary.js';
import type { Summarizer } from './types.js';
import { normalizeWorkstreams } from './workstreams.js';

/**
 * Stage three: a transcript in, a structured summary out.
 *
 * The model is constrained by a decoding grammar, so the JSON *parses*. What
 * it can still do is violate the parts of the schema a grammar cannot express
 * and produce content that is simply wrong. Hence three lines of defence, in
 * descending order of how good the outcome is:
 *
 *  1. **Validate.** Zod, against the same schema the grammar came from.
 *  2. **Repair.** One re-prompt carrying the validation error and the rejected
 *     answer. Once, not in a loop: a small model that failed twice on the same
 *     instruction is not going to get it on the fifth try, and each attempt
 *     costs minutes on CPU.
 *  3. **Salvage.** Keep the fields that did validate, empty the rest, and mark
 *     the result degraded. A summary with three good topics and no action
 *     items beats posting nothing, as long as it says which it is.
 */

/** Model calls before giving up. One attempt, one repair. */
const MAX_ATTEMPTS = 2;

/** The repair attempt runs hotter: the first answer was a dead end. */
const REPAIR_TEMPERATURE = 0.5;

export interface SummarizeOptions {
  summarizer: Summarizer;
  /** Must match the provider's context setting, or the prompt will overflow. */
  contextTokens?: number;
  /**
   * The team's standing workstreams. Supplying them turns naming into sorting,
   * which is a far easier job for a small model and keeps section names stable
   * from one week's summary to the next.
   */
  workstreams?: readonly string[];
}

/** Summarises a meeting directory and writes `summary.json` into it. */
export async function summarizeMeeting(
  dir: string,
  transcript: MeetingTranscript,
  options: SummarizeOptions,
): Promise<MeetingSummaryDocument> {
  const document = await summarize(transcript, options);
  await writeSummary(dir, document);
  return document;
}

/** The same work without touching disk. */
export async function summarize(
  transcript: MeetingTranscript,
  options: SummarizeOptions,
): Promise<MeetingSummaryDocument> {
  const { summarizer } = options;
  const contextTokens = options.contextTokens ?? 8_192;
  const started = Date.now();

  const speakers = transcript.participants.map((participant) => participant.displayName);
  const workstreams = options.workstreams ?? [];
  const schema = buildSummarySchema({ speakers, workstreams });
  const jsonSchema = summaryJsonSchema({ speakers, workstreams });
  const system = buildSystemPrompt(workstreams);
  const prompt = buildUserPrompt(transcript, contextTokens);

  if (prompt.truncated) {
    log.warn(
      `Transcript did not fit ${contextTokens} tokens of context; the opening was dropped. ` +
        'Raise SUMMARY_CONTEXT_TOKENS or use a longer-context model.',
    );
  }

  let user = prompt.text;
  let raw = '';
  let problem = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    log.info(`Summarising with ${summarizer.name}/${summarizer.model} (attempt ${attempt})`);

    raw = await summarizer.complete({
      system,
      user,
      schema: jsonSchema,
      temperature: attempt === 1 ? undefined : REPAIR_TEMPERATURE,
    });

    const parsed = parse(raw, schema);
    if (parsed.ok) {
      return document(transcript, summarizer, normalizeWorkstreams(parsed.value, workstreams), {
        attempts: attempt,
        degraded: false,
        truncated: prompt.truncated,
        started,
      });
    }

    problem = parsed.problem;
    log.warn(`Summary rejected on attempt ${attempt}: ${problem}`);
    user = `${prompt.text}\n\n${buildRepairPrompt(raw, problem)}`;
  }

  // Both attempts failed. Keep whatever survived rather than posting nothing.
  const salvaged = normalizeWorkstreams(salvage(raw, schema), workstreams);
  log.error(`Summary degraded after ${MAX_ATTEMPTS} attempts. Last problem: ${problem}`);

  return document(transcript, summarizer, salvaged, {
    attempts: MAX_ATTEMPTS,
    degraded: true,
    truncated: prompt.truncated,
    started,
  });
}

type Parsed = { ok: true; value: MeetingSummary } | { ok: false; problem: string };

function parse(raw: string, schema: SummarySchema): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Should be impossible under a decoding grammar, which is exactly why it
    // is worth reporting distinctly if it ever happens.
    return { ok: false, problem: 'the answer was not valid JSON' };
  }

  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data as MeetingSummary };

  return { ok: false, problem: describeIssues(result.error) };
}

/** Zod's own message is a wall of JSON; the model needs a sentence. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Rebuilds a summary from the fields that individually validate.
 *
 * One bad action item should not cost the topics as well, and a top-level
 * parse is all-or-nothing. Walking the schema field by field turns a total
 * loss into a partial one.
 */
function salvage(raw: string, schema: SummarySchema): MeetingSummary {
  const fallback = emptySummary();

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return fallback;
  }

  if (typeof json !== 'object' || json === null) return fallback;

  const source = json as Record<string, unknown>;
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const result = { ...fallback } as Record<string, unknown>;

  for (const [key, field] of Object.entries(shape)) {
    if (!(key in source)) continue;

    const parsed = field.safeParse(source[key]);
    if (parsed.success) result[key] = parsed.data;
    else log.debug(`Salvage dropped field "${key}": ${describeIssues(parsed.error)}`);
  }

  return result as unknown as MeetingSummary;
}

function document(
  transcript: MeetingTranscript,
  summarizer: Summarizer,
  summary: MeetingSummary,
  meta: { attempts: number; degraded: boolean; truncated: boolean; started: number },
): MeetingSummaryDocument {
  return {
    version: 1,
    meetingId: transcript.meetingId,
    summarisedAt: new Date().toISOString(),
    provider: summarizer.name,
    model: summarizer.model,
    attempts: meta.attempts,
    degraded: meta.degraded,
    truncated: meta.truncated,
    seconds: Math.round(((Date.now() - meta.started) / 1000) * 100) / 100,
    summary,
  };
}
