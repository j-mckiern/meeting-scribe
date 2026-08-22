import { MessageFlags } from 'discord.js';
import { disconnectFromGuild } from '../../../capture/discord/connection.js';
import { stopRecording } from '../../../capture/discord/recorder.js';
import type { MeetingManifest } from '../../../capture/types.js';
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

    // Capture first, connection second. Tearing down the socket would cut off
    // anyone mid-sentence; stopping the recorder lets those bursts flush.
    const manifest = await stopRecording(interaction.guildId);
    disconnectFromGuild(interaction.guildId);

    const duration = formatDuration(Date.now() - session.startedAt.getTime());

    // M5 replaces this with: transcribe -> summarize -> post, editing this same
    // reply as each stage completes.
    sessions.end(interaction.guildId);

    await interaction.editReply(
      [
        `⏹️ **Recording stopped** after ${duration}.`,
        describeCapture(manifest),
        '_Transcription and summary are not wired up yet (milestone 5)._',
      ].join('\n'),
    );
  },
};

/** What was actually captured - the only feedback there is until M2 lands. */
function describeCapture(manifest: MeetingManifest | null): string {
  if (!manifest) return 'No audio was captured.';

  const { segments, participants } = manifest;
  if (segments.length === 0) {
    return 'No speech was captured - nobody was heard on the channel.';
  }

  const speechMs = segments.reduce((total, segment) => total + segment.durationMs, 0);
  const names = participants.map((p) => p.displayName).join(', ');

  return (
    `Captured ${segments.length} segment${segments.length === 1 ? '' : 's'} ` +
    `(${formatDuration(speechMs)} of speech) from ${participants.length} ` +
    `speaker${participants.length === 1 ? '' : 's'}: ${names}.`
  );
}
