# meeting-scribe

A Discord bot that records a team meeting from a voice channel, transcribes it
with per-speaker attribution, and posts a structured summary to a text channel.

**Status: milestone 1.** The bot joins a voice channel and records it,
producing one WAV file per burst of speech per person plus a `manifest.json`
tying them to a timeline. Transcription and summarisation land in milestones
2-5.

---

## Setup

You need a Discord bot application, a server to run it on, and (from milestone 2
onward) two free API keys.

### 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> and click **New
   Application**. Name it whatever you like - this is the name that shows in
   the member list.
2. Open the **Bot** tab and click **Reset Token**. Copy the token somewhere
   safe; Discord shows it exactly once. This is `DISCORD_BOT_TOKEN`.
3. On the **General Information** tab, copy the **Application ID**. This is
   `DISCORD_APPLICATION_ID`.

There are no privileged intents to enable. The bot uses `Guilds` and
`GuildVoiceStates`, neither of which requires a portal toggle.

### 2. Invite the bot to your server

Open this URL with your own application ID substituted in:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=1068032
```

That permission number is exactly: View Channels, Send Messages, Embed Links,
and Connect. Nothing else.

### 3. Collect the channel IDs

Turn on **User Settings -> Advanced -> Developer Mode**, then right-click to
copy IDs:

- your server icon -> **Copy Server ID** -> `DISCORD_SERVER_ID`
- your `#meeting-summary` channel -> **Copy Channel ID** -> `SUMMARY_CHANNEL_ID`

### 4. Get the API keys (needed from milestone 2)

- **Groq** (Whisper transcription): <https://console.groq.com> -> API Keys
- **Google AI Studio** (summarisation): <https://aistudio.google.com> -> Get API key

Both are free tiers and neither requires a credit card.

---

## Running it

### On a server (how it is meant to run)

```bash
git clone <your-repo-url> meeting-scribe
cd meeting-scribe
cp .env.example .env
# fill in .env

# The container runs as uid 1000; the bind-mounted data dir must be writable
# by it, or the first transcript write will fail with EACCES.
mkdir -p data && sudo chown -R 1000:1000 data

docker compose up -d --build
docker compose exec scribe node dist/bot/register.js   # register slash commands
docker compose logs -f
```

Re-run the `register` step only when a command's name, description, or options
change. Editing a command's behaviour does not need it.

> **Building on ARM:** build the image *on the server*, as above. Building on an
> x86 laptop and pushing the image to an ARM box produces binaries that fail at
> runtime. If you must build elsewhere, use
> `docker buildx build --platform linux/arm64`.

### Locally, for development

```bash
npm install
cp .env.example .env    # fill it in
npm run register        # once
npm run dev             # watches src/ and restarts
```

To check what a recording actually captured:

```bash
npm run inspect -- data/meetings/<meetingId>
```

It prints the meeting as a timeline of speaker turns and verifies that every
file in the manifest exists and is the length the manifest claims.

---

## Commands

| Command | What it does |
| --- | --- |
| `/meeting-scribe start [title]` | Joins your current voice channel and starts recording |
| `/meeting-scribe stop` | Leaves, transcribes, summarises, and posts to `#meeting-summary` |
| `/meeting-scribe cancel confirm:true` | Leaves and discards everything - nothing is posted |
| `/meeting-scribe status` | Shows whether a recording is running, for how long, and who has been heard |

Planned for milestone 6: `/meeting-scribe pause`, `/meeting-scribe resume`,
`/meeting-scribe note <text>`, `/meeting-scribe retry`.

---

## How it fits together

```
Discord voice  ->  capture/  ->  transcribe/  ->  summarize/  ->  report/  ->  #meeting-summary
                (per-speaker     (Whisper)       (LLM, JSON      (Discord
                 audio segments)                  schema)         embeds)
```

`capture/` is the only part that knows about Discord audio. Everything
downstream consumes plain audio segments, which is what would make a future
Zoom or Google Meet source a drop-in addition rather than a rewrite.

Discord sends one audio stream per speaker rather than one mixed stream, so who
said what is known exactly and no diarization model is needed. A recording is a
directory:

```
data/meetings/<meetingId>/
  manifest.json                 # speakers, timeline, audio format
  audio/00006900-<userId>.wav   # one file per burst of speech, named by offset
```

`manifest.json` is rewritten after every burst, so a crash mid-meeting still
leaves a usable recording behind - an `endedAt` of `null` is how you tell one
that was interrupted from one that was stopped.

Raw audio is deleted as soon as a transcript exists. Transcripts are kept, so a
summary can be regenerated later without re-recording.

## Troubleshooting

**Commands don't appear in Discord.** Run the register step. Check
`DISCORD_APPLICATION_ID` and `DISCORD_SERVER_ID` are the application ID and server ID
respectively - swapping them is the usual cause.

**"Timed out joining the voice channel".** The bot lacks Connect or View
Channel permission on that specific channel. Channel-level overrides beat
server-level ones.

**Bot appears in the voice channel, then leaves after ~20 seconds.** The voice
handshake never completed. Run with `LOG_LEVEL=debug` - the startup dependency
report and the `Voice state:` lines show how far it got. The usual cause is an
outdated `@discordjs/voice`: Discord now negotiates the DAVE end-to-end
encryption protocol, which needs `@snazzah/davey` (a dependency of voice
`>= 0.19`). Older versions stall at `signalling` or `connecting` forever.

**Bot joins but hears nothing.** It is server-deafened. Right-click the bot in
the voice channel and undeafen it. `/meeting-scribe status` distinguishes this
from a working recording: it reports how many segments have been captured so
far, which stays at zero in this case.

**"Joined the channel but could not start recording".** The data directory is
not writable. In Docker it must be owned by uid 1000 - see the `chown` in the
setup steps above.
