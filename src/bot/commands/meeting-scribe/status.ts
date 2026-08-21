import { MessageFlags, channelMention, userMention } from 'discord.js';
import { sessions } from '../../../session/state.js';
import { formatDuration } from '../../../util/time.js';
import type { Subcommand } from '../types.js';

export const status: Subcommand = {
  name: 'status',

  build: (subcommand) =>
    subcommand.setDescription('Show whether a recording is in progress'),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command only works inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const session = sessions.get(interaction.guildId);

    if (!session) {
      await interaction.reply({
        content: 'Idle - no recording in progress. Start one with `/meeting-scribe start`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const elapsed = formatDuration(Date.now() - session.startedAt.getTime());
    const lines = [
      `**State:** \`${session.state}\``,
      `**Elapsed:** ${elapsed}`,
      `**Channel:** ${channelMention(session.voiceChannelId)}`,
      `**Started by:** ${userMention(session.startedBy)}`,
      `**Meeting id:** \`${session.meetingId}\``,
    ];

    if (session.title) lines.unshift(`**Title:** ${session.title}`);

    await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
  },
};
