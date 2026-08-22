import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * The shape of a meeting summary, defined once.
 *
 * Single source of truth for three things that must not drift apart: the type
 * M4 renders, the validator the repair loop runs, and the JSON Schema handed
 * to the model as a decoding constraint.
 *
 * Two ideas carry most of the weight here:
 *
 *  1. **Workstreams are bins, not inventions.** A team's workstreams are the
 *     same week to week, so they are configuration. Sorting discussion into
 *     four known buckets is a far easier job for a small model than inventing
 *     a taxonomy, and it stops the summary renaming its own sections every
 *     week. When none are configured the model names them itself.
 *  2. **Names are enums, never free strings.** A grammar built from the list
 *     of people actually present cannot name someone who was not there, nor
 *     misspell someone who was. Attribution is the known weak spot, so it is
 *     removed from the model's discretion rather than checked afterwards.
 *
 * Deliberately shallow. Decisions, action items and open questions each carry
 * a workstream tag rather than nesting inside one, so a renderer can group
 * them under their workstream while the model still only fills flat lists.
 */

/** The bucket for discussion that fits no configured workstream. */
export const OTHER_WORKSTREAM = 'Other';

export interface MeetingSummary {
  headline: string;
  overview: string;
  /** What was discussed, grouped by workstream, in the configured order. */
  workstreams: { name: string; points: string[] }[];
  /** What each attendee needs to know or act on. The hard inference. */
  perPerson: { person: string; points: string[] }[];
  decisions: { decision: string; context: string; workstream: string }[];
  actionItems: {
    task: string;
    owner: string | null;
    dueDate: string | null;
    workstream: string;
  }[];
  openQuestions: { question: string; workstream: string }[];
}

export interface SummarySchemaOptions {
  /** Display names of everyone heard in the meeting. */
  speakers: readonly string[];
  /** Configured workstreams. Empty lets the model name its own. */
  workstreams?: readonly string[];
}

export function buildSummarySchema(options: SummarySchemaOptions) {
  const { speakers, workstreams = [] } = options;

  // An empty enum is not a legal schema, so both of these fall back to a free
  // string when there is nothing to constrain them to.
  const speaker = speakers.length > 0 ? z.enum([speakers[0]!, ...speakers.slice(1)]) : z.string();

  // Free text, not an enum, even when workstreams are configured: projects
  // end and new ones start, and the meeting leader announcing "let's talk
  // about Project Aurora" has to be able to produce a section by that name.
  // Consistency is recovered afterwards by `workstreams.ts`, which snaps
  // recognisable names onto the configured spelling.
  void workstreams;
  const workstream = z.string();

  return z.object({
    headline: z
      .string()
      .describe('One sentence, under 100 characters, saying what this meeting was about.'),
    overview: z
      .string()
      .describe('Two or three sentences summarising the meeting for someone who missed it.'),
    workstreams: z
      .array(
        z.object({
          name: workstream.describe('Which workstream this section covers.'),
          points: z
            .array(z.string())
            .describe('Short bullets, one fact each, of what was said about this workstream.'),
        }),
      )
      .describe('Only workstreams that were actually discussed. Omit the rest.'),
    perPerson: z
      .array(
        z.object({
          person: speaker,
          points: z
            .array(z.string())
            .describe('What this person needs to know or do, including things others said.'),
        }),
      )
      .describe('One entry per person with anything relevant to them.'),
    decisions: z
      .array(
        z.object({
          decision: z.string().describe('What was decided, stated as a completed decision.'),
          context: z.string().describe('Why, in one sentence.'),
          workstream,
        }),
      )
      .describe('Only things actually settled. An empty list is correct if nothing was.'),
    actionItems: z
      .array(
        z.object({
          task: z.string().describe('What needs doing, starting with a verb.'),
          owner: speaker.nullable().describe('Who agreed to do it themselves, or null.'),
          dueDate: z.string().nullable().describe('Only if a date was actually said. Else null.'),
          workstream,
        }),
      )
      .describe('Only commitments someone actually made. An empty list is correct if none were.'),
    openQuestions: z
      .array(z.object({ question: z.string(), workstream }))
      .describe('Questions raised and left unanswered. Empty is correct if there were none.'),
  });
}

/** The per-meeting validator, whose `.shape` the salvage path walks. */
export type SummarySchema = ReturnType<typeof buildSummarySchema>;

/**
 * The same schema as JSON Schema, for the provider's structured-output
 * parameter. Generated rather than hand-written so it cannot drift.
 */
export function summaryJsonSchema(options: SummarySchemaOptions): Record<string, unknown> {
  return zodToJsonSchema(buildSummarySchema(options), {
    // Constrained decoding wants one self-contained schema, not a document
    // with $ref pointers into a definitions block.
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;
}

/** What the pipeline falls back to when the model cannot be trusted at all. */
export function emptySummary(): MeetingSummary {
  return {
    headline: 'Summary unavailable',
    overview: 'The transcript was recorded, but no usable summary could be generated from it.',
    workstreams: [],
    perPerson: [],
    decisions: [],
    actionItems: [],
    openQuestions: [],
  };
}
