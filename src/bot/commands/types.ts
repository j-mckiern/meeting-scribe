import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandBuilder,
} from 'discord.js';

/**
 * A top-level slash command: `data` is what Discord shows in the UI, `execute`
 * runs when it is invoked.
 */
export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

/**
 * One branch of a grouped command, e.g. the `start` in `/meeting-scribe start`.
 *
 * `build` receives a subcommand builder that already has its name set, and
 * returns it with the description and any options attached. The parent command
 * owns assembly and routing; a subcommand only describes itself.
 */
export interface Subcommand {
  name: string;
  build(subcommand: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}
