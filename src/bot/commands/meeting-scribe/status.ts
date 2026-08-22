import { MessageFlags, channelMention, userMention } from 'discord.js';
import { getRecorder } from '../../../capture/discord/recorder.js';
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

    // Reading the live manifest is the quickest way to tell "recording" from
    // "in a channel where the microphones are all muted".
    const manifest = getRecorder(interaction.guildId)?.snapshot();
    if (manifest) {
      const speechMs = manifest.segments.reduce((total, s) => total + s.durationMs, 0);
      lines.push(
        `**Captured:** ${manifest.segments.length} segments, ${formatDuration(speechMs)} of speech`,
      );
      if (manifest.participants.length > 0) {
        lines.push(`**Heard:** ${manifest.participants.map((p) => p.displayName).join(', ')}`);
      }
    }

    if (session.title) lines.unshift(`**Title:** ${session.title}`);

    await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
  },
};
