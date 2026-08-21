import { Client, GatewayIntentBits } from 'discord.js';

/**
 * Intents tell Discord which events to send us. Ask for the minimum:
 *
 *  - Guilds:           basic server/channel data, required for slash commands
 *  - GuildVoiceStates: who is in which voice channel. Required to see the
 *                      caller's voice channel and to hold a voice connection.
 *
 * Neither is a "privileged" intent, so there is nothing to toggle in the
 * developer portal. (Only Presence, Server Members, and Message Content are.)
 */
export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
}
