import { resolve } from 'node:path';
import { config } from '../src/config.js';
import { readTranscript } from '../src/transcribe/transcript.js';
import { summarizeMeeting } from '../src/summarize/index.js';
import { OllamaSummarizer } from '../src/summarize/ollama.js';
import { summaryPath, type MeetingSummaryDocument } from '../src/summarize/summary.js';

/**
 * Runs the summarisation stage on its own.
 *
 *   npm run summarize -- data/meetings/<meetingId>
 *
 * Reads `transcript.json` and writes `summary.json` next to it. Separate from
 * transcription so a prompt can be iterated without re-running the model over
 * the audio every time - which, self-hosted, is the difference between a
 * ten-second loop and a ten-minute one.
 */

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: npm run summarize -- <meetingDir>');
    process.exit(1);
  }

  const dir = resolve(target);
  const transcript = await readTranscript(dir);

  if (transcript.utterances.length === 0) {
    console.error('That transcript has no utterances. Nothing to summarise.');
    process.exit(1);
  }

  const document = await summarizeMeeting(dir, transcript, {
    workstreams: config.MEETING_WORKSTREAMS,
    summarizer: new OllamaSummarizer({
      baseUrl: config.OLLAMA_URL,
      model: config.SUMMARY_MODEL,
      contextTokens: config.SUMMARY_CONTEXT_TOKENS,
    }),
    contextTokens: config.SUMMARY_CONTEXT_TOKENS,
  });

  print(document);
  console.log(`Written to ${summaryPath(dir)}\n`);
}

function print(document: MeetingSummaryDocument): void {
  const { summary } = document;

  console.log(`\nSummary     ${document.meetingId}`);
  console.log(`Model       ${document.provider}/${document.model}`);
  console.log(
    `Run         ${document.seconds}s, ${document.attempts} attempt` +
      `${document.attempts === 1 ? '' : 's'}` +
      `${document.degraded ? '  DEGRADED - assembled from partial output' : ''}` +
      `${document.truncated ? '  TRUNCATED - transcript did not fit' : ''}`,
  );

  console.log(`\n${summary.headline}\n`);
  console.log(summary.overview);

  // Rendered the way the summary is meant to be read: workstream by
  // workstream, with everything belonging to a workstream underneath it.
  for (const stream of summary.workstreams) {
    console.log(`\n${stream.name}:`);
    for (const point of stream.points) console.log(`  * ${point}`);

    under('Decisions', summary.decisions, stream.name, (d) => `${d.decision} - ${d.context}`);
    under('Action items', summary.actionItems, stream.name, (a) =>
      `${a.task} [${a.owner ?? 'unassigned'}${a.dueDate ? `, due ${a.dueDate}` : ''}]`,
    );
    under('Open questions', summary.openQuestions, stream.name, (q) => q.question);
  }

  for (const person of summary.perPerson) {
    console.log(`\n${person.person}`);
    for (const point of person.points) console.log(`  * ${point}`);
  }

  console.log();
}

/** Items tagged with this workstream, printed under its heading. */
function under<T extends { workstream: string }>(
  label: string,
  items: readonly T[],
  workstream: string,
  render: (item: T) => string,
): void {
  const mine = items.filter((item) => item.workstream === workstream);
  if (mine.length === 0) return;

  console.log(`  ${label}:`);
  for (const item of mine) console.log(`    - ${render(item)}`);
}

function indent(text: string, spaces = 2): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
