import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from '../config.js';

/**
 * Where a meeting lives on disk:
 *
 *   <DATA_DIR>/meetings/<meetingId>/manifest.json
 *   <DATA_DIR>/meetings/<meetingId>/audio/<startMs>-<userId>.wav
 *
 * One directory per meeting, so discarding one is a single `rm -r` and
 * deleting the audio after transcription (the retention model) does not have
 * to hunt for files scattered across a shared folder.
 */

/** Matches ids from buildMeetingId(); anything else has no business here. */
const MEETING_ID = /^[A-Za-z0-9-]{1,64}$/;

export const meetingsRoot = join(resolve(config.DATA_DIR), 'meetings');

export function meetingDir(meetingId: string): string {
  // deleteMeeting() below removes a directory tree, so refuse to build a path
  // out of anything that could contain `..` before that becomes a problem.
  if (!MEETING_ID.test(meetingId)) {
    throw new Error(`Refusing to build a path for suspicious meeting id: ${meetingId}`);
  }
  return join(meetingsRoot, meetingId);
}

export function audioDir(meetingId: string): string {
  return join(meetingDir(meetingId), 'audio');
}

/** Creates the meeting directory and its audio subdirectory. Returns the former. */
export async function createMeetingDir(meetingId: string): Promise<string> {
  await mkdir(audioDir(meetingId), { recursive: true });
  return meetingDir(meetingId);
}

/** Used by `/meeting-scribe cancel`. Succeeds if the directory is already gone. */
export async function deleteMeeting(meetingId: string): Promise<void> {
  await rm(meetingDir(meetingId), { recursive: true, force: true });
}
