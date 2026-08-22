import { stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { readManifest } from '../src/capture/manifest.js';
import { formatClock, formatDuration } from '../src/util/time.js';
import type { AudioSegment, MeetingManifest } from '../src/capture/types.js';

/**
 * Prints a captured meeting as a timeline and checks it against itself.
 *
 *   npm run inspect -- data/meetings/<meetingId>
 *
 * This exists because the only way to know capture is correct is to compare it
 * to a meeting you remember: read the timeline, and the turns should be in the
 * order they happened, at the times they happened. The checks at the bottom
 * catch the failures that are not obvious by eye - a manifest claiming a
 * duration its WAV file does not have, or a file that is not there at all.
 */

const WAV_HEADER_BYTES = 44;

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: npm run inspect -- <meetingDir>');
    process.exit(1);
  }

  const meetingDir = resolve(dir);
  const manifest = await readManifest(meetingDir);

  printHeader(manifest);
  printSpeakers(manifest);
  printTimeline(manifest);
  await printChecks(meetingDir, manifest);
}

function printHeader(manifest: MeetingManifest): void {
  const { audio } = manifest;
  const started = new Date(manifest.startedAt);
  const ended = manifest.endedAt ? new Date(manifest.endedAt) : null;

  console.log(`\nMeeting  ${manifest.meetingId}${manifest.title ? ` - ${manifest.title}` : ''}`);
  console.log(`Started  ${started.toISOString()}`);
  console.log(
    ended
      ? `Ended    ${ended.toISOString()}  (${formatDuration(ended.getTime() - started.getTime())} wall clock)`
      : 'Ended    never - this meeting was interrupted, not stopped',
  );
  console.log(`Audio    ${audio.container}/${audio.encoding} ${audio.sampleRate} Hz, ${audio.channels} ch`);
}

function printSpeakers(manifest: MeetingManifest): void {
  console.log('\nSpeakers');

  if (manifest.participants.length === 0) {
    console.log('  (nobody was heard)');
    return;
  }

  const width = Math.max(...manifest.participants.map((p) => p.displayName.length));

  for (const participant of manifest.participants) {
    const mine = manifest.segments.filter((s) => s.userId === participant.userId);
    const speechMs = mine.reduce((total, s) => total + s.durationMs, 0);
    console.log(
      `  ${participant.displayName.padEnd(width)}  ` +
        `${String(mine.length).padStart(4)} segments  ${formatDuration(speechMs).padStart(9)}`,
    );
  }
}

function printTimeline(manifest: MeetingManifest): void {
  console.log('\nTimeline');

  if (manifest.segments.length === 0) {
    console.log('  (no segments)');
    return;
  }

  const width = Math.max(...manifest.segments.map((s) => s.displayName.length));

  for (const segment of manifest.segments) {
    const end = segment.startMs + segment.durationMs;
    console.log(
      `  [${formatClock(segment.startMs)} - ${formatClock(end)}]  ` +
        `${segment.displayName.padEnd(width)}  ` +
        `${(segment.durationMs / 1000).toFixed(1).padStart(6)}s  ` +
        basename(segment.file),
    );
  }
}

async function printChecks(meetingDir: string, manifest: MeetingManifest): Promise<void> {
  console.log('\nChecks');

  const { segments } = manifest;
  if (segments.length === 0) {
    console.log('  nothing to check');
    return;
  }

  const bytesPerMs = (manifest.audio.sampleRate * manifest.audio.channels * 2) / 1000;
  const problems: string[] = [];

  for (const segment of segments) {
    let sizeBytes: number;
    try {
      sizeBytes = (await stat(join(meetingDir, segment.file))).size;
    } catch {
      problems.push(`missing file: ${segment.file}`);
      continue;
    }

    // Allow a millisecond of slack: durationMs is rounded when written.
    const actualMs = Math.round((sizeBytes - WAV_HEADER_BYTES) / bytesPerMs);
    if (Math.abs(actualMs - segment.durationMs) > 1) {
      problems.push(
        `${segment.file}: manifest says ${segment.durationMs} ms, file holds ${actualMs} ms`,
      );
    }
  }

  const outOfOrder = segments.some((s, i) => i > 0 && s.startMs < segments[i - 1]!.startMs);
  if (outOfOrder) problems.push('segments are not sorted by startMs');

  for (const problem of problems) console.log(`  FAIL  ${problem}`);
  if (problems.length === 0) {
    console.log(`  OK    all ${segments.length} files present and the right length`);
  }

  const lastEnd = Math.max(...segments.map((s) => s.startMs + s.durationMs));
  const speechMs = segments.reduce((total, s) => total + s.durationMs, 0);
  const talkingMs = mergedSpan(segments);

  // Overlap is not an error - it is the point. Three people talking over each
  // other should show up here as a large number, and a round-robin
  // conversation as roughly zero.
  console.log(`  overlap   ${formatDuration(speechMs - talkingMs)} of simultaneous speech`);
  console.log(
    `  coverage  ${((talkingMs / lastEnd) * 100).toFixed(0)}% of the meeting had someone speaking`,
  );
  console.log();
}

/** Total time with at least one person speaking, counting overlap once. */
function mergedSpan(segments: AudioSegment[]): number {
  const ranges = segments
    .map((s) => [s.startMs, s.startMs + s.durationMs] as const)
    .sort((a, b) => a[0] - b[0]);

  let total = 0;
  let [, cursor] = ranges[0] ?? [0, 0];
  let start = ranges[0]?.[0] ?? 0;

  for (const [from, to] of ranges) {
    if (from > cursor) {
      total += cursor - start;
      start = from;
    }
    cursor = Math.max(cursor, to);
  }

  return total + (cursor - start);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
