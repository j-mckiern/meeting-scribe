import { MessageFlags } from 'discord.js';
import { disconnectFromGuild } from '../../../capture/discord/connection.js';
import { sessions } from '../../../session/state.js';
import { log } from '../../../logger.js';
import type { Subcommand } from '../types.js';

export const cancel: Subcommand = {
  name: 'cancel',

  build: (subcommand) =>
    subcommand
      .setDescription('Stop recording and discard everything - no summary is posted')
      .addBooleanOption((option) =>
        option
          .setName('confirm')
          .setDescription('This deletes the recording permanently. Set to true to proceed.')
          .setRequired(true),
      ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command only works inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.options.getBoolean('confirm', true)) {
      await interaction.reply({
        content: 'Cancelled nothing - set `confirm` to **True** if you really want to discard the recording.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // require() throws a user-facing SessionError if nothing is running.
    sessions.require(interaction.guildId);

    disconnectFromGuild(interaction.guildId);
    const session = sessions.end(interaction.guildId);

    // M1 adds: delete data/meetings/<meetingId>/ here.
    log.info('Session cancelled', { meetingId: session.meetingId });

    await interaction.reply(
      `🗑️ **Recording cancelled.** Nothing was saved and no summary will be posted.`,
    );
  },
};
