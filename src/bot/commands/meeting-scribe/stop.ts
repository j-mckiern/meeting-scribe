import { MessageFlags } from 'discord.js';
import { disconnectFromGuild } from '../../../capture/discord/connection.js';
import { sessions } from '../../../session/state.js';
import { formatDuration } from '../../../util/time.js';
import type { Subcommand } from '../types.js';

export const stop: Subcommand = {
  name: 'stop',

  build: (subcommand) =>
    subcommand.setDescription('Stop recording and post the summary'),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command only works inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Moving to 'processing' first means a second /meeting-scribe stop is rejected by the
    // state machine while the pipeline is still running.
    const session = sessions.transition(interaction.guildId, 'processing');

    await interaction.deferReply();
    disconnectFromGuild(interaction.guildId);

    const duration = formatDuration(Date.now() - session.startedAt.getTime());

    // M5 replaces this with: transcribe -> summarize -> post, editing this same
    // reply as each stage completes.
    sessions.end(interaction.guildId);

    await interaction.editReply(
      `⏹️ **Recording stopped** after ${duration}.\n` +
        '_Transcription and summary are not wired up yet (milestone 5)._',
    );
  },
};
