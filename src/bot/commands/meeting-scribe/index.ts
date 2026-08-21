import { SlashCommandBuilder } from 'discord.js';
import type { Command, Subcommand } from '../types.js';
import { cancel } from './cancel.js';
import { start } from './start.js';
import { status } from './status.js';
import { stop } from './stop.js';

/**
 * `/meeting-scribe start | stop | cancel | status`
 *
 * Grouping under one command keeps these together in Discord's picker. The
 * name is deliberately the bot's own rather than a generic one: `/recording`,
 * `/stop`, and `/status` are all plausible commands for another bot in the
 * same server to have registered.
 *
 * Adding a subcommand means creating a file and adding it to this array -
 * assembly and routing below are driven off it.
 */
const subcommands: Subcommand[] = [start, stop, cancel, status];

const byName = new Map(subcommands.map((sub) => [sub.name, sub]));

const data = new SlashCommandBuilder()
  .setName('meeting-scribe')
  .setDescription('Record a meeting and post a summary');

// discord.js builders mutate in place and return `this`, so a loop works here
// and keeps the definition driven by the array rather than a hand-written chain.
for (const sub of subcommands) {
  data.addSubcommand((builder) => sub.build(builder.setName(sub.name)));
}

export const meetingScribe: Command = {
  data,

  async execute(interaction) {
    // Discord guarantees a subcommand was chosen, since the parent command
    // cannot be invoked on its own once subcommands are defined.
    const name = interaction.options.getSubcommand();
    const sub = byName.get(name);

    if (!sub) {
      // Only reachable if a subcommand was registered with Discord but later
      // removed from the array - i.e. a stale registration.
      throw new Error(`No handler for /meeting-scribe ${name}. Re-run \`npm run register\`.`);
    }

    await sub.execute(interaction);
  },
};
