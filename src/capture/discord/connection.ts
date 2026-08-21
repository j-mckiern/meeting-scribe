import {
  joinVoiceChannel,
  entersState,
  getVoiceConnection,
  VoiceConnectionStatus,
  type VoiceConnection,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { config } from '../../config.js';
import { log } from '../../logger.js';

/**
 * Voice connection lifecycle. This is the only file in M0 that knows Discord
 * voice exists; M1 builds per-speaker audio capture on top of it.
 */

const READY_TIMEOUT_MS = 20_000;

export interface ConnectOptions {
  /**
   * Called when the connection is gone for good and will not recover. The
   * caller is responsible for tearing down whatever it started - this module
   * deliberately knows nothing about sessions.
   */
  onLost?: () => void;
}

export async function connectToChannel(
  channel: VoiceBasedChannel,
  options: ConnectOptions = {},
): Promise<VoiceConnection> {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,

    // MUST be false. A deafened bot connects successfully and receives no
    // audio at all - which looks like a broken recorder, not a config problem.
    selfDeaf: false,

    // We only ever listen, never transmit.
    selfMute: true,
  });

  // Attach before awaiting Ready so the whole handshake is visible at debug
  // level. The sequence should be: signalling -> connecting -> ready.
  connection.on('stateChange', (oldState, newState) => {
    log.debug(`Voice state: ${oldState.status} -> ${newState.status}`);
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
  } catch {
    // Where it stalled narrows the cause a lot, so surface it rather than
    // guessing at permissions.
    const stalledAt = connection.state.status;
    connection.destroy();

    throw new Error(
      `Timed out joining the voice channel (stalled at "${stalledAt}"). ` +
        'Common causes: the bot lacks Connect permission on that channel, ' +
        'outbound UDP is blocked, or @discordjs/voice is too old to negotiate ' +
        'the encryption Discord now requires. Run with LOG_LEVEL=debug for the ' +
        'full handshake.',
    );
  }

  handleDisconnects(connection, options.onLost);

  log.info('Joined voice channel', { channelId: channel.id, guildId: channel.guild.id });
  return connection;
}

/**
 * A Disconnected event is ambiguous: it means either "the websocket blipped and
 * we're about to reconnect" or "we were kicked / moved / the channel died".
 *
 * The library reconnects on its own, but only for as long as we let it. We wait
 * VOICE_RECONNECT_GRACE_SECONDS for the connection to come back to Ready before
 * declaring it dead - long enough to survive a network hiccup mid-meeting
 * rather than silently abandoning a recording over a two-second blip.
 */
function handleDisconnects(connection: VoiceConnection, onLost?: () => void): void {
  let recovering = false;

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    // Several Disconnected events can fire during one outage; only run the
    // recovery race once.
    if (recovering) return;
    recovering = true;

    const graceMs = config.VOICE_RECONNECT_GRACE_SECONDS * 1000;
    log.warn(`Voice connection dropped; trying to recover for up to ${config.VOICE_RECONNECT_GRACE_SECONDS}s`);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, graceMs);
      log.info('Voice connection recovered');
      recovering = false;
    } catch {
      log.warn('Voice connection did not recover; ending');
      connection.destroy();
      onLost?.();
    }
  });

  connection.on('error', (err) => {
    log.error('Voice connection error', err);
  });
}

export function disconnectFromGuild(guildId: string): void {
  const connection = getVoiceConnection(guildId);
  if (!connection) return;

  connection.destroy();
  log.info('Left voice channel', { guildId });
}
