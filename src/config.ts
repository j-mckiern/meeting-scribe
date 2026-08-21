import 'dotenv/config';
import { z } from 'zod';

/**
 * Every environment variable the app reads, declared in one place.
 *
 * The point of validating here is that a missing or malformed value should
 * crash at boot with a clear message, rather than surfacing as a confusing
 * failure ten minutes into a meeting.
 */

// Discord IDs ("snowflakes") are numeric strings, currently 17-20 digits.
const snowflake = z
  .string()
  .regex(/^\d{17,20}$/, 'must be a Discord ID (17-20 digits, copied via Developer Mode)');

const schema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, 'required - the bot token from the Discord dev portal'),
  DISCORD_APPLICATION_ID: snowflake,
  DISCORD_SERVER_ID: snowflake,
  SUMMARY_CHANNEL_ID: snowflake,

  // Not needed until M2/M3, so optional for now. They become required when the
  // transcription and summarization steps land.
  GROQ_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),

  DATA_DIR: z.string().default('./data'),

  // How long to keep trying to recover a dropped voice connection before
  // giving up and ending the recording.
  VOICE_RECONNECT_GRACE_SECONDS: z.coerce.number().int().positive().default(120),

  // Dev-only escape hatch: keep recorded audio instead of deleting it after
  // transcription, so you can re-run the pipeline without re-recording.
  KEEP_AUDIO: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof schema>;

/**
 * `FOO=` in a .env file gives you an empty string, not an absent variable - so
 * a commented-out-but-still-present key would fail `.min(1)` validation and
 * `.default()` would never fire. Dropping blanks up front makes "left empty"
 * behave identically to "not there at all", which is what people expect.
 */
function withoutBlanks(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].trim() !== '',
    ),
  );
}

function load(): Config {
  const parsed = schema.safeParse(withoutBlanks(process.env));

  if (!parsed.success) {
    console.error('\nInvalid configuration. Fix these entries in your .env file:\n');
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    console.error('\nSee .env.example for the full list.\n');
    process.exit(1);
  }

  return parsed.data;
}

export const config = load();
