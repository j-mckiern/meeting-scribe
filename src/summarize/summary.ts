import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeetingSummary } from './schema.js';

/**
 * Reading and writing `summary.json`, the third file in a meeting directory.
 *
 * Same shape as `manifest.ts` and `transcript.ts`: directory in, no config,
 * atomic write. Kept on disk rather than only posted to Discord so that
 * `/retry` can re-render an embed without re-running the model, and so a
 * failed Discord post is not a lost summary.
 */

export const SUMMARY_FILE = 'summary.json';

/** What was produced, and how much to trust it. */
export interface MeetingSummaryDocument {
  version: 1;
  meetingId: string;
  summarisedAt: string;
  provider: string;
  model: string;
  /** Model calls made. 2 means the first answer failed validation. */
  attempts: number;
  /**
   * True when the model never produced a valid summary and this was assembled
   * from whatever parts survived. M4 should say so rather than present it as
   * a clean result.
   */
  degraded: boolean;
  /** True when the transcript did not fit the context window. */
  truncated: boolean;
  seconds: number;
  summary: MeetingSummary;
}

export function summaryPath(dir: string): string {
  return join(dir, SUMMARY_FILE);
}

export async function writeSummary(dir: string, document: MeetingSummaryDocument): Promise<void> {
  const target = summaryPath(dir);
  const temp = `${target}.tmp`;

  await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

export async function readSummary(dir: string): Promise<MeetingSummaryDocument> {
  return JSON.parse(await readFile(summaryPath(dir), 'utf8')) as MeetingSummaryDocument;
}
