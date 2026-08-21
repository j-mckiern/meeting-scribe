import { meetingScribe } from './meeting-scribe/index.js';
import type { Command } from './types.js';

/** The one place a new top-level command has to be registered. */
export const commandList: Command[] = [meetingScribe];

export const commands = new Map<string, Command>(
  commandList.map((command) => [command.data.name, command]),
);

export type { Command };
