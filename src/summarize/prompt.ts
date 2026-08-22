import type { MeetingTranscript } from '../transcribe/types.js';
import { OTHER_WORKSTREAM } from './schema.js';
import { formatClock } from '../util/time.js';

/**
 * Turning a transcript into something a small model can summarise.
 *
 * The instructions here are shaped by what a 4-14B model gets wrong. It will
 * invent action items because meeting summaries usually have them; it will
 * attribute a decision to whoever spoke last; and it will pad an empty list
 * rather than return one. Each of those gets an explicit instruction, because
 * a small model follows a stated rule far more reliably than it infers an
 * unstated one.
 */

/** Roughly how many characters make a token in English prose. */
const CHARS_PER_TOKEN = 4;

/** Context left for the system prompt and the model's own output. */
const RESERVED_TOKENS = 2_000;

/**
 * The rules a small model needs stated rather than inferred.
 *
 * Each line here exists because a 4-14B model gets that thing wrong by
 * default: it invents action items because meeting summaries usually have
 * them, it credits whoever spoke last rather than whoever agreed, and it pads
 * an empty list rather than returning one.
 */
export function buildSystemPrompt(workstreams: readonly string[]): string {
  const lines = [
    'You summarise transcripts of team meetings.',
    '',
    'Rules:',
    '- Use only what the transcript says. Never add information that is not there.',
    '- An empty list is the correct answer when nothing of that kind happened.',
    '  Do not invent decisions, action items or questions to fill a list.',
    '- Only record an action item if someone actually committed to doing something.',
    '  "Someone should look at that" and "I might if I get time" are not commitments.',
    '- Only name someone as an owner if they agreed to do it themselves. The person',
    '  who proposed the work is often not the person who took it on.',
    '- Only record a due date if a date was actually spoken. Otherwise use null.',
    '- For each person, list what they need to know or act on - including things',
    '  other people said that affect their work, not only their own words.',
    '- A person\'s section is what matters TO them, not a list of what they said.',
    '  What they agreed to, what was decided that affects them, what they are',
    '  waiting on. If nothing in the meeting affects someone, give them no points.',
    '- Never copy sentences out of the transcript. Write everything in your own',
    '  words, in the third person, without quoting the speaker.',
    '- Write for someone who missed the meeting and wants to know what happened.',
  ];

  lines.push(
    '',
    'Workstreams:',
    // The single most reliable signal available. Whoever runs the meeting
    // announces each section out loud, which makes the boundaries explicit
    // rather than something the model has to infer from topic drift.
    '- The person leading the meeting usually announces each one, e.g. "moving on',
    '  to the main workstream" or "let\'s talk about Project X". Treat those',
    '  announcements as the section boundaries.',
    '- Name a workstream exactly as it was said in the meeting.',
    `- Use "${OTHER_WORKSTREAM}" only for discussion that belongs to no workstream.`,
    '- Omit a workstream entirely if it was not discussed.',
  );

  if (workstreams.length > 0) {
    lines.push(
      `- These usually come up, but are not the only ones: ${workstreams.join(', ')}.`,
      '  A workstream not on that list is fine if it was announced in the meeting.',
    );
  }

  return lines.join('\n');
}

export interface RenderedTranscript {
  text: string;
  /** True when the transcript did not fit and the opening was dropped. */
  truncated: boolean;
}

/**
 * Renders the transcript as timestamped dialogue.
 *
 * When it does not fit, the *opening* is dropped rather than the end. Meetings
 * put their decisions and commitments at the end, and those are what the
 * summary is mostly for - losing the small talk it opened with costs less than
 * losing what was agreed. Silently overflowing the context would drop the same
 * text without saying so, which is the outcome worth avoiding.
 */
export function renderTranscript(
  transcript: MeetingTranscript,
  contextTokens: number,
): RenderedTranscript {
  const lines = transcript.utterances.map(
    (utterance) => `[${formatClock(utterance.startMs)}] ${utterance.displayName}: ${utterance.text}`,
  );

  const budget = Math.max(1_000, (contextTokens - RESERVED_TOKENS) * CHARS_PER_TOKEN);

  const kept: string[] = [];
  let used = 0;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (used + line.length > budget) break;
    used += line.length + 1;
    kept.unshift(line);
  }

  const truncated = kept.length < lines.length;

  return {
    text: truncated ? `[earlier discussion omitted]\n${kept.join('\n')}` : kept.join('\n'),
    truncated,
  };
}

export function buildUserPrompt(transcript: MeetingTranscript, contextTokens: number): {
  text: string;
  truncated: boolean;
} {
  const rendered = renderTranscript(transcript, contextTokens);
  const speakers = transcript.participants.map((p) => p.displayName).join(', ');

  const parts = [
    transcript.title ? `Meeting: ${transcript.title}` : null,
    speakers ? `People present: ${speakers}` : null,
    rendered.truncated
      ? 'Note: this transcript was too long to include in full. The opening is missing.'
      : null,
    '',
    'Transcript:',
    rendered.text,
  ].filter((part): part is string => part !== null);

  return { text: parts.join('\n'), truncated: rendered.truncated };
}

/** Appended on a repair attempt so the model can see what it got wrong. */
export function buildRepairPrompt(previous: string, problem: string): string {
  return [
    'Your previous answer was rejected.',
    '',
    `What was wrong: ${problem}`,
    '',
    'Your previous answer:',
    previous.slice(0, 2_000),
    '',
    'Answer again, correcting that problem. Follow the schema exactly.',
  ].join('\n');
}
