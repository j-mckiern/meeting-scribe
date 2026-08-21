import { REST, Routes } from 'discord.js';
import { config } from '../config.js';
import { commandList } from './commands/index.js';

/**
 * Uploads the slash command definitions to Discord. Run this once after
 * deploying, and again whenever a command's name, description, or options
 * change - editing the handler alone does not need a re-register.
 *
 * We register per-guild (not globally) because guild commands appear
 * instantly, while global commands can take up to an hour to propagate.
 */
async function main(): Promise<void> {
  const rest = new REST().setToken(config.DISCORD_BOT_TOKEN);
  const body = commandList.map((command) => command.data.toJSON());

  console.log(`Registering ${body.length} commands to guild ${config.DISCORD_SERVER_ID}...`);

  await rest.put(
    Routes.applicationGuildCommands(config.DISCORD_APPLICATION_ID, config.DISCORD_SERVER_ID),
    { body },
  );

  console.log('Done:', body.map((c) => `/${c.name}`).join(', '));
}

main().catch((error) => {
  console.error('Failed to register commands:', error);
  process.exit(1);
});
