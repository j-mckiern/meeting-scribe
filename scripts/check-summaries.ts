import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { summarize } from '../src/summarize/index.js';
import { OllamaSummarizer } from '../src/summarize/ollama.js';
import type { MeetingSummary } from '../src/summarize/schema.js';
import type { MeetingTranscript } from '../src/transcribe/types.js';

/**
 * Runs the real model against hand-written transcripts whose correct answer is
 * known in advance.
 *
 *   npm run check-summaries            # all fixtures
 *   npm run check-summaries -- ordinary
 *
 * The point of hand-writing the transcripts is that there is a right answer.
 * Run the model on a real meeting and you can only read the output and nod at
 * it - a fluent summary and a correct one look identical. Here, the fixture
 * says there were exactly two commitments and who made them, so "the model
 * invented a third" is a test failure rather than something nobody notices.
 *
 * Assertions are on structure, never on prose: counts, owners, whether a name
 * appears where it should not. The wording varies run to run and is not the
 * thing under test. What the model actually wrote is printed underneath so the
 * prose can be judged by eye at the same time.
 */

const WORKSTREAMS = ['Main Workstream', 'Data Pipeline', 'On-call'];

interface Check {
  name: string;
  /** Each returns null when satisfied, or a description of what went wrong. */
  assertions: ((summary: MeetingSummary) => string | null)[];
}

const CHECKS: Check[] = [
  {
    name: 'ordinary',
    assertions: [
      atLeast('workstreams', 3, (s) => s.workstreams.length),
      (s) =>
        s.workstreams.some((w) => /data pipeline/i.test(w.name))
          ? null
          : `no Data Pipeline section (got ${names(s)})`,
      atLeast('decisions', 1, (s) => s.decisions.length),
      atLeast('actionItems', 2, (s) => s.actionItems.length),
      owns('Priya', /query plan|investigat|dig/i),
      // "We should probably retune that threshold" is a musing, not a commitment.
      (s) =>
        s.actionItems.some((a) => /retune|threshold/i.test(a.task))
          ? 'invented an action item from "we should probably retune that threshold"'
          : null,
    ],
  },
  {
    name: 'nothing-decided',
    assertions: [
      exactly('decisions', 0, (s) => s.decisions.length),
      exactly('actionItems', 0, (s) => s.actionItems.length),
    ],
  },
  {
    name: 'attribution',
    assertions: [
      atLeast('actionItems', 1, (s) => s.actionItems.length),
      owns('Sean', /migration script|migration/i),
      (s) =>
        s.actionItems.some((a) => /migration/i.test(a.task) && a.owner === 'Aoife')
          ? 'credited the migration script to Aoife, who only proposed it'
          : null,
    ],
  },
  {
    name: 'non-commitment',
    assertions: [exactly('actionItems', 0, (s) => s.actionItems.length)],
  },
  {
    name: 'new-workstream',
    assertions: [
      (s) =>
        s.workstreams.some((w) => /aurora/i.test(w.name))
          ? null
          : `Project Aurora got no section of its own (got ${names(s)})`,
      (s) =>
        s.workstreams.some((w) => /aurora/i.test(w.name) && /^other$/i.test(w.name.trim()))
          ? 'Project Aurora was filed under Other'
          : null,
    ],
  },
];

/** Applied to every fixture: things that must never happen anywhere. */
function universal(transcript: MeetingTranscript): Check['assertions'] {
  const people = new Set(transcript.participants.map((p) => p.displayName));

  return [
    (s) => {
      const ghost = s.actionItems.find((a) => a.owner !== null && !people.has(a.owner));
      return ghost ? `action item owned by "${ghost.owner}", who was not present` : null;
    },
    (s) => {
      const ghost = s.perPerson.find((p) => !people.has(p.person));
      return ghost ? `per-person section for "${ghost.person}", who was not present` : null;
    },
    (s) => (s.headline.trim().length > 0 ? null : 'empty headline'),
    (s) => {
      const bare = s.workstreams.find((w) => w.points.length === 0);
      return bare ? `emitted "${bare.name}" as a heading with no content` : null;
    },
    // The first fixture run produced per-person sections that were verbatim
    // transcript lines, speaker prefix and all. Structurally valid, useless to
    // read, and invisible to every other assertion here.
    (s) => {
      const spoken = transcript.utterances.map((u) => u.text.trim().toLowerCase());
      const copied = s.perPerson
        .flatMap((person) => person.points)
        .find((point) => spoken.some((line) => line.length > 30 && point.toLowerCase().includes(line)));
      return copied ? `copied a transcript line verbatim: "${copied.slice(0, 60)}..."` : null;
    },
  ];
}

async function main(): Promise<void> {
  const only = process.argv[2];
  const wanted = only ? CHECKS.filter((c) => c.name === only) : CHECKS;

  if (wanted.length === 0) {
    console.error(`No fixture named "${only}". Known: ${CHECKS.map((c) => c.name).join(', ')}`);
    process.exit(1);
  }

  const summarizer = new OllamaSummarizer({
    baseUrl: config.OLLAMA_URL,
    model: config.SUMMARY_MODEL,
    contextTokens: config.SUMMARY_CONTEXT_TOKENS,
  });

  console.log(`\nModel  ${summarizer.name}/${summarizer.model}`);
  console.log(`Workstreams  ${WORKSTREAMS.join(', ')}\n`);

  let failed = 0;

  for (const check of wanted) {
    const transcript = JSON.parse(
      await readFile(join('fixtures/transcripts', `${check.name}.json`), 'utf8'),
    ) as MeetingTranscript;

    const document = await summarize(transcript, {
      summarizer,
      workstreams: WORKSTREAMS,
      contextTokens: config.SUMMARY_CONTEXT_TOKENS,
    });

    const problems = [...check.assertions, ...universal(transcript)]
      .map((assertion) => assertion(document.summary))
      .filter((problem): problem is string => problem !== null);

    if (problems.length > 0) failed += 1;

    console.log(
      `${problems.length === 0 ? 'PASS' : 'FAIL'}  ${check.name.padEnd(16)} ` +
        `${document.seconds}s, ${document.attempts} attempt(s)` +
        `${document.degraded ? ', DEGRADED' : ''}`,
    );
    for (const problem of problems) console.log(`        - ${problem}`);
    console.log(render(document.summary));
  }

  console.log(
    failed === 0
      ? `\n  all ${wanted.length} fixtures passed\n`
      : `\n  ${failed}/${wanted.length} fixtures failed\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

function render(summary: MeetingSummary): string {
  const lines: string[] = [];

  for (const stream of summary.workstreams) {
    lines.push(`          ${stream.name}:`);
    for (const point of stream.points) lines.push(`            * ${point}`);
  }
  for (const item of summary.actionItems) {
    lines.push(`          ACTION [${item.owner ?? 'unassigned'}] ${item.task}  (${item.workstream})`);
  }
  for (const decision of summary.decisions) {
    lines.push(`          DECIDED ${decision.decision}  (${decision.workstream})`);
  }
  for (const person of summary.perPerson) {
    lines.push(`          ${person.person}: ${person.points.join(' | ') || '(nothing)'}`);
  }

  return lines.join('\n');
}

function atLeast(
  label: string,
  min: number,
  count: (s: MeetingSummary) => number,
): (s: MeetingSummary) => string | null {
  return (s) => (count(s) >= min ? null : `expected at least ${min} ${label}, got ${count(s)}`);
}

function exactly(
  label: string,
  want: number,
  count: (s: MeetingSummary) => number,
): (s: MeetingSummary) => string | null {
  return (s) => (count(s) === want ? null : `expected ${want} ${label}, got ${count(s)}`);
}

/** Someone must own an action item matching `pattern`. */
function owns(person: string, pattern: RegExp): (s: MeetingSummary) => string | null {
  return (s) => {
    const matching = s.actionItems.filter((item) => pattern.test(item.task));
    if (matching.length === 0) return `no action item matching ${pattern}`;
    return matching.some((item) => item.owner === person)
      ? null
      : `${pattern} owned by ${matching.map((m) => m.owner ?? 'nobody').join('/')}, expected ${person}`;
  };
}

function names(summary: MeetingSummary): string {
  return summary.workstreams.map((w) => w.name).join(', ') || 'nothing';
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
