import { MessageFlags } from 'discord.js';
import { disconnectFromGuild } from '../../../capture/discord/connection.js';
import { stopRecording } from '../../../capture/discord/recorder.js';
import { deleteMeeting } from '../../../storage/paths.js';
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

    // Deleting the directory out from under a running recorder would leave it
    // writing into an unlinked tree, so stop capture before removing anything.
    await interaction.deferReply();
    await stopRecording(interaction.guildId);
    disconnectFromGuild(interaction.guildId);

    const session = sessions.end(interaction.guildId);
    await deleteMeeting(session.meetingId);

    log.info('Session cancelled, recording deleted', { meetingId: session.meetingId });

    await interaction.editReply(
      `🗑️ **Recording cancelled.** Nothing was saved and no summary will be posted.`,
    );
  },
};
