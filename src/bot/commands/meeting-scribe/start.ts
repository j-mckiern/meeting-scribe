import { GuildMember, MessageFlags, PermissionsBitField } from 'discord.js';
import { connectToChannel } from '../../../capture/discord/connection.js';
import { sessions } from '../../../session/state.js';
import { log } from '../../../logger.js';
import type { Subcommand } from '../types.js';

export const start: Subcommand = {
  name: 'start',

  build: (subcommand) =>
    subcommand
      .setDescription('Start recording the voice channel you are in')
      .addStringOption((option) =>
        option
          .setName('title')
          .setDescription('Optional name for this meeting, used in the summary')
          .setMaxLength(100),
      ),

  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: 'This command only works inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // interaction.member is a GuildMember for in-guild commands, but the type
    // allows a raw API object, so narrow it before touching .voice.
    const member = interaction.member;
    if (!(member instanceof GuildMember)) {
      await interaction.reply({
        content: 'Could not read your voice state. Try again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      await interaction.reply({
        content: 'Join a voice channel first, then run `/meeting-scribe start`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Check permissions up front so we fail with a useful message rather than
    // a 20-second connection timeout.
    const me = interaction.guild.members.me;
    const permissions = me ? voiceChannel.permissionsFor(me) : null;
    const required = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect];

    if (!permissions?.has(required)) {
      await interaction.reply({
        content: `I need **View Channel** and **Connect** permissions on ${voiceChannel.toString()}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Claim the session slot before connecting. If someone runs /meeting-scribe start twice
    // in quick succession, the second one fails here instead of both bots
    // racing to join.
    const session = sessions.start({
      guildId: interaction.guildId,
      voiceChannelId: voiceChannel.id,
      textChannelId: interaction.channelId,
      title: interaction.options.getString('title'),
      startedBy: interaction.user.id,
    });

    // Joining can take a few seconds; acknowledge within Discord's 3s window.
    await interaction.deferReply();

    const guildId = interaction.guildId;

    try {
      await connectToChannel(voiceChannel, {
        // If the connection dies mid-meeting and can't be recovered, release
        // the session slot. Without this the store still says 'recording' with
        // no voice connection behind it: /meeting-scribe status lies, and
        // /meeting-scribe start refuses to
        // start a new one until the process restarts.
        onLost: () => {
          try {
            sessions.end(guildId);
          } catch {
            // Already ended by /meeting-scribe stop or /meeting-scribe cancel - nothing to do.
          }

          log.warn('Recording ended early: voice connection lost', { guildId });

          if (interaction.channel?.isSendable()) {
            void interaction.channel.send(
              '⚠️ Lost the voice connection and could not reconnect. ' +
                'The recording has ended.',
            );
          }
        },
      });
    } catch (error) {
      sessions.end(guildId);
      log.error('Failed to join voice channel', error);
      await interaction.editReply(
        error instanceof Error ? error.message : 'Could not join the voice channel.',
      );
      return;
    }

    const titleSuffix = session.title ? `: **${session.title}**` : '';
    await interaction.editReply(
      `🔴 **Recording started**${titleSuffix}\n` +
        `Channel: ${voiceChannel.toString()} · Started by ${interaction.user.toString()}\n` +
        'Everyone in this channel is being recorded. Use `/meeting-scribe stop` to finish, `/meeting-scribe cancel` to discard.',
    );
  },
};
