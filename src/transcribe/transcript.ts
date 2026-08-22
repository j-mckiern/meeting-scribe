import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeetingTranscript } from './types.js';

/**
 * Reading and writing `transcript.json`, alongside the `manifest.json` it was
 * produced from.
 *
 * Same shape as `capture/manifest.ts` and for the same reasons: takes a
 * directory rather than a meeting id, imports no config, and writes through a
 * temp file so a reader never catches a half-written file.
 */

export const TRANSCRIPT_FILE = 'transcript.json';

export function transcriptPath(dir: string): string {
  return join(dir, TRANSCRIPT_FILE);
}

export async function writeTranscript(dir: string, transcript: MeetingTranscript): Promise<void> {
  const target = transcriptPath(dir);
  const temp = `${target}.tmp`;

  await writeFile(temp, `${JSON.stringify(transcript, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

export async function readTranscript(dir: string): Promise<MeetingTranscript> {
  return JSON.parse(await readFile(transcriptPath(dir), 'utf8')) as MeetingTranscript;
}

/**
 * Whether this meeting has already been transcribed. The retention model
 * deletes audio once a transcript exists, so this is also the question "is it
 * safe to delete the audio" - and, for `/retry`, "can this be re-summarised".
 */
export async function hasTranscript(dir: string): Promise<boolean> {
  try {
    await readFile(transcriptPath(dir), 'utf8');
    return true;
  } catch {
    return false;
  }
}
