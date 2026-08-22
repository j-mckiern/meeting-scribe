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

  // --- Transcription -------------------------------------------------------
  // `local` keeps the audio on this machine; `groq` uploads it. Local is the
  // default deliberately: the recordings are of people who agreed to be in a
  // meeting, not to be sent to an inference vendor.
  TRANSCRIBER: z.enum(['local', 'groq']).default('local'),

  // Interpreter with faster-whisper installed. See README for the one-liner.
  WHISPER_PYTHON: z.string().default('./.venv-whisper/bin/python'),

  // Any CTranslate2 Whisper model. `turbo` is ~8x faster than large-v3 at
  // close to the same quality, which is what makes CPU-only viable.
  WHISPER_MODEL: z.string().min(1).default('deepdml/faster-whisper-large-v3-turbo-ct2'),

  // `auto`, `cpu`, or `cuda`. Left on auto so the same .env works on a laptop
  // and on a machine with a GPU.
  WHISPER_DEVICE: z.string().default('auto'),

  // `auto`, or pin it: `int8` on CPU, `float16` on a GPU.
  WHISPER_COMPUTE_TYPE: z.string().default('auto'),

  // --- Summarisation -------------------------------------------------------
  // The team's standing workstreams, in the order they should appear, comma
  // separated. Supplying them turns naming into sorting - a far easier job for
  // a small model - and keeps section names stable week to week. Leave blank
  // and the model names its own.
  MEETING_WORKSTREAMS: z
    .string()
    .optional()
    .transform((value) =>
      value ? value.split(',').map((name) => name.trim()).filter(Boolean) : [],
    ),

  // Ollama's address. Point it at another machine on the LAN to borrow its GPU
  // while developing on a laptop.
  OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434'),

  // Any model `ollama pull` accepts. Small models are viable here because the
  // JSON structure is enforced by a decoding grammar, not by the model.
  SUMMARY_MODEL: z.string().min(1).default('qwen3:4b'),

  // Transcript + prompt + output, in tokens. Costs RAM, and on CPU it costs
  // time; too small and the opening of a long meeting gets dropped.
  SUMMARY_CONTEXT_TOKENS: z.coerce.number().int().positive().default(8192),

  GROQ_MODEL: z.string().min(1).default('whisper-large-v3-turbo'),

  // ISO-639-1, or `auto` to let the model detect each segment on its own.
  // Pinning it is the default because detection runs per segment here, and a
  // few seconds of a noisy microphone is enough for the model to "detect"
  // another language and translate the rest of the burst into it.
  TRANSCRIPTION_LANGUAGE: z.string().min(2).max(5).default('en'),

  // Names, products and jargon Whisper would otherwise mangle, passed to the
  // model as context preceding each segment. Proper nouns, not sentences.
  TRANSCRIPTION_VOCABULARY: z.string().optional(),

  // Requests in flight against the transcription provider. The Groq free tier
  // is rate limited per minute, so more than a handful just buys 429s.
  TRANSCRIBE_CONCURRENCY: z.coerce.number().int().positive().max(16).default(3),

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
