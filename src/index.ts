import { Events, MessageFlags, type Interaction } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { config } from './config.js';
import { log } from './logger.js';
import { createClient } from './bot/client.js';
import { commands } from './bot/commands/index.js';
import { disconnectFromGuild } from './capture/discord/connection.js';
import { stopRecording } from './capture/discord/recorder.js';
import { SessionError, sessions } from './session/state.js';

const client = createClient();

client.once(Events.ClientReady, (ready) => {
  log.info(`Logged in as ${ready.user.tag}`);

  // Voice failures are usually a missing or outdated native dependency, and
  // this report is the fastest way to see which. Cheap enough to always run
  // when debugging.
  if (config.LOG_LEVEL === 'debug') {
    log.debug(`Voice dependencies:\n${generateDependencyReport()}`);
  }
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) {
    log.warn('Unknown command received', interaction.commandName);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    // SessionError messages are written for users ("no recording in
    // progress"). Anything else is a bug, so show something generic and put
    // the detail in the logs.
    const isUserFacing = error instanceof SessionError;
    if (!isUserFacing) {
      log.error(`Command /${interaction.commandName} failed`, error);
    }

    const content = isUserFacing
      ? error.message
      : 'Something went wrong. Check the bot logs for details.';

    // Whether we reply or edit depends on whether the command already
    // acknowledged the interaction before throwing.
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content }).catch(() => {});
    } else {
      await interaction
        .reply({ content, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
});

/**
 * Docker sends SIGTERM on `docker compose stop`. Leave voice channels
 * deliberately rather than letting the connection time out, so the bot doesn't
 * linger as a ghost member of the channel.
 *
 * Recorders are flushed first: a restart mid-meeting should cost the tail of
 * the recording, not the manifest that makes the rest of it usable.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`Received ${signal}, shutting down`);

  await Promise.allSettled(
    sessions.all().map(async (session) => {
      await stopRecording(session.guildId);
      disconnectFromGuild(session.guildId);
    }),
  );

  await client.destroy().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await client.login(config.DISCORD_BOT_TOKEN);
