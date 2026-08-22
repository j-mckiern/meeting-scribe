import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeetingManifest } from './types.js';

/**
 * Reading and writing `manifest.json`.
 *
 * Takes a directory rather than a meeting id, and imports no config, so tools
 * can point it at any directory on disk without a valid `.env`.
 */

export const MANIFEST_FILE = 'manifest.json';

export function manifestPath(dir: string): string {
  return join(dir, MANIFEST_FILE);
}

/**
 * Write to a temp file and rename over the target. The manifest is rewritten
 * after every burst while the meeting is still running, so without this a
 * reader (or a crash) could catch it half-written; rename is atomic within a
 * filesystem, so readers see either the old file or the new one.
 */
export async function writeManifest(dir: string, manifest: MeetingManifest): Promise<void> {
  const target = manifestPath(dir);
  const temp = `${target}.tmp`;

  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

export async function readManifest(dir: string): Promise<MeetingManifest> {
  return JSON.parse(await readFile(manifestPath(dir), 'utf8')) as MeetingManifest;
}
