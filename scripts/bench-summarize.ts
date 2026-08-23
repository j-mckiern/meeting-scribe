import { readFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import { summarize } from '../src/summarize/index.js';
import { OllamaSummarizer } from '../src/summarize/ollama.js';
import type { MeetingTranscript } from '../src/transcribe/types.js';

/**
 * How summarisation time scales with transcript length, on this machine.
 *
 *   npm run bench-summarize
 *
 * One timing number answers nothing useful. The question that decides where
 * this gets hosted is "what happens to a real meeting", and a real meeting is
 * several times longer than anything convenient to test with. So this runs the
 * same transcript truncated to increasing lengths and prints the curve, which
 * extrapolates.
 *
 * Prefill dominates on CPU and scales with input, so expect the seconds column
 * to grow faster than the words column. If it grows much faster than linearly,
 * that is the finding.
 */

const FRACTIONS = [0.25, 0.5, 0.75, 1];
const WORKSTREAMS = ['Main Workstream', 'Data Pipeline', 'On-call'];

async function main(): Promise<void> {
  const source = JSON.parse(
    await readFile('fixtures/long-meeting/transcript.json', 'utf8'),
  ) as MeetingTranscript;

  const summarizer = new OllamaSummarizer({
    baseUrl: config.OLLAMA_URL,
    model: config.SUMMARY_MODEL,
    contextTokens: config.SUMMARY_CONTEXT_TOKENS,
  });

  console.log(`\nModel    ${summarizer.name}/${summarizer.model}`);
  console.log(`Context  ${config.SUMMARY_CONTEXT_TOKENS} tokens\n`);
  console.log('  utterances    words    approx tokens    seconds    words/sec');

  for (const fraction of FRACTIONS) {
    // Kept from the start so each run is a coherent meeting rather than a
    // fragment beginning mid-sentence.
    const utterances = source.utterances.slice(
      0,
      Math.max(1, Math.round(source.utterances.length * fraction)),
    );
    const words = utterances.reduce((total, u) => total + u.text.split(/\s+/).length, 0);

    const document = await summarize(
      { ...source, utterances },
      { summarizer, workstreams: WORKSTREAMS, contextTokens: config.SUMMARY_CONTEXT_TOKENS },
    );

    console.log(
      `  ${String(utterances.length).padStart(10)}   ${String(words).padStart(6)}   ` +
        `${String(Math.round(words * 1.35)).padStart(13)}   ${document.seconds.toFixed(1).padStart(8)}   ` +
        `${(words / document.seconds).toFixed(1).padStart(10)}` +
        `${document.truncated ? '   TRUNCATED' : ''}` +
        `${document.degraded ? '   DEGRADED' : ''}`,
    );
  }

  console.log(
    '\n  A real 30-minute meeting runs roughly 4000 words. Extrapolate the last\n' +
      '  row and compare against how long you are willing to wait after /stop.\n',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
