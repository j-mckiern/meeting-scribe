import { readdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { EndBehaviorType, type VoiceConnection, type VoiceReceiver } from '@discordjs/voice';
import type { AudioReceiveStream } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { opus } from 'prism-media';
import { log } from '../../logger.js';
import { audioDir, createMeetingDir, meetingDir } from '../../storage/paths.js';
import { writeManifest } from '../manifest.js';
import {
  DECODE_CHANNELS,
  OUTPUT_CHANNELS,
  SAMPLE_RATE,
  SegmentSink,
} from '../segment-sink.js';
import type { AudioSegment, MeetingManifest, MeetingMeta, Participant } from '../types.js';

/**
 * Per-speaker capture.
 *
 * Discord hands out one audio stream per speaker rather than a single mixed
 * one, which is the whole reason this project needs no diarization model: who
 * said what is not inferred, it is given. This file is where that is exploited.
 *
 * A "burst" is one uninterrupted run of speech. Subscribing with
 * `AfterSilence` means Discord's own voice activity detection decides where
 * bursts end, so segmentation costs nothing and matches what a human would
 * mark as a pause.
 */

/** How long a speaker must be silent before their burst is considered over. */
const BURST_END_SILENCE_MS = 1_000;

/** 20 ms at 48 kHz - one Discord frame. */
const FRAME_SIZE = 960;

export interface StartRecordingOptions {
  connection: VoiceConnection;
  channel: VoiceBasedChannel;
  meeting: MeetingMeta;
}

export class MeetingRecorder {
  readonly #meeting: MeetingMeta;
  readonly #channel: VoiceBasedChannel;
  readonly #receiver: VoiceReceiver;
  readonly #dir: string;

  readonly #segments: AudioSegment[] = [];
  /** Display name lookups, cached as promises so concurrent bursts share one fetch. */
  readonly #names = new Map<string, Promise<string>>();
  /** Bursts currently being captured, one per speaker. */
  readonly #active = new Map<string, AudioReceiveStream>();
  readonly #inFlight = new Set<Promise<void>>();

  #startedAtMs = 0;
  #stopped = false;
  /** Serialises manifest writes so two bursts finishing together cannot interleave. */
  #save: Promise<void> = Promise.resolve();

  constructor(options: StartRecordingOptions) {
    this.#meeting = options.meeting;
    this.#channel = options.channel;
    this.#receiver = options.connection.receiver;
    this.#dir = meetingDir(options.meeting.meetingId);
  }

  async start(): Promise<void> {
    await createMeetingDir(this.#meeting.meetingId);

    // Write the (empty) manifest up front and let it throw. An unwritable
    // data directory is the single most likely deployment mistake here, and
    // failing at `/meeting-scribe start` is far kinder than discovering it
    // when someone stops a meeting an hour later.
    await writeManifest(this.#dir, this.#buildManifest(null));

    this.#startedAtMs = Date.now();
    this.#receiver.speaking.on('start', this.#onSpeakingStart);

    log.info('Recording started', { meetingId: this.#meeting.meetingId, dir: this.#dir });
  }

  /**
   * Ends every in-flight burst and writes the final manifest. Safe to call
   * twice; the second call just re-writes the manifest.
   */
  async stop(): Promise<MeetingManifest> {
    if (!this.#stopped) {
      this.#stopped = true;
      this.#receiver.speaking.off('start', this.#onSpeakingStart);

      // Push EOF rather than destroying: buffered audio still flushes, and we
      // do not sit through the silence window for someone mid-sentence.
      for (const stream of this.#active.values()) stream.push(null);
    }

    await Promise.allSettled([...this.#inFlight]);

    const manifest = this.#buildManifest(new Date());
    await this.#persist(manifest);
    await this.#removeUnlistedAudio(manifest);

    log.info('Recording stopped', {
      meetingId: this.#meeting.meetingId,
      segments: manifest.segments.length,
      participants: manifest.participants.length,
    });

    return manifest;
  }

  /** The manifest as it stands, without writing it. Used for status reporting. */
  snapshot(): MeetingManifest {
    return this.#buildManifest(null);
  }

  readonly #onSpeakingStart = (userId: string): void => {
    if (this.#stopped) return;

    // The same speaker can trip this event again while their burst is still
    // being captured; `receiver.subscribe` would hand back the identical
    // stream and we would end up with two pipelines writing one file.
    if (this.#active.has(userId)) return;

    // The bot is muted and never transmits, but do not rely on that.
    if (userId === this.#channel.client.user?.id) return;

    // Start the name lookup now so it is almost certainly resolved by the time
    // the burst ends and the segment needs it.
    void this.#displayName(userId).catch(() => {});

    const burst = this.#captureBurst(userId).catch((error: unknown) => {
      log.error(`Unexpected error capturing user ${userId}`, error);
    });

    this.#inFlight.add(burst);
    void burst.finally(() => this.#inFlight.delete(burst));
  };

  async #captureBurst(userId: string): Promise<void> {
    const startMs = Date.now() - this.#startedAtMs;

    const stream = this.#receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: BURST_END_SILENCE_MS },
    });
    this.#active.set(userId, stream);

    const decoder = new opus.Decoder({
      rate: SAMPLE_RATE,
      channels: DECODE_CHANNELS,
      frameSize: FRAME_SIZE,
    });

    const sink = new SegmentSink({
      meetingDir: this.#dir,
      userId,
      startMs,
      displayName: () => this.#displayName(userId),
    });

    try {
      await pipeline(stream, decoder, sink);
    } catch (error) {
      // Whatever the sink managed to close before failing is still valid
      // audio. Fall through and keep it rather than leaving files on disk
      // that no manifest mentions.
      log.error(`Capture failed for user ${userId}`, error);
    } finally {
      this.#active.delete(userId);
    }

    if (sink.segments.length === 0) return;

    this.#segments.push(...sink.segments);

    // Keep the manifest current so a crash mid-meeting still leaves something
    // M2 can run against.
    await this.#persist(this.#buildManifest(null)).catch((error: unknown) => {
      log.error('Failed to update manifest', error);
    });
  }

  /**
   * Deletes audio files no segment refers to.
   *
   * The manifest is the contract, so a file it does not mention is either
   * wasted disk or the remains of a burst that failed - and M2 walking the
   * directory instead of the manifest would treat the second kind as real
   * audio. Run once, at stop, when the segment list is final.
   */
  async #removeUnlistedAudio(manifest: MeetingManifest): Promise<void> {
    const dir = audioDir(this.#meeting.meetingId);
    const listed = new Set(manifest.segments.map((segment) => basename(segment.file)));

    try {
      for (const name of await readdir(dir)) {
        if (listed.has(name)) continue;

        await unlink(join(dir, name));
        log.warn('Deleted an audio file the manifest does not list', {
          meetingId: this.#meeting.meetingId,
          file: name,
        });
      }
    } catch (error) {
      // Nothing here is worth failing a stop over - the manifest is written.
      log.error('Could not sweep the audio directory', error);
    }
  }

  #displayName(userId: string): Promise<string> {
    const cached = this.#names.get(userId);
    if (cached) return cached;

    const pending = this.#resolveDisplayName(userId);
    this.#names.set(userId, pending);
    return pending;
  }

  async #resolveDisplayName(userId: string): Promise<string> {
    // Server nickname if there is one, otherwise the global display name.
    try {
      const member =
        this.#channel.guild.members.cache.get(userId) ??
        (await this.#channel.guild.members.fetch(userId));
      return member.displayName;
    } catch {
      // Not a member any more, or the fetch failed. Fall through.
    }

    try {
      const user = await this.#channel.client.users.fetch(userId);
      return user.displayName;
    } catch {
      // A name we cannot look up is still better than dropping the audio.
      return `Unknown speaker (${userId})`;
    }
  }

  #buildManifest(endedAt: Date | null): MeetingManifest {
    const segments = [...this.#segments].sort((a, b) => a.startMs - b.startMs);

    // First-heard order, latest name wins - a Map preserves insertion order
    // while set() on an existing key leaves the position alone.
    const names = new Map<string, string>();
    for (const segment of segments) names.set(segment.userId, segment.displayName);

    const participants: Participant[] = [...names].map(([userId, displayName]) => ({
      userId,
      displayName,
    }));

    return {
      version: 1,
      meetingId: this.#meeting.meetingId,
      guildId: this.#meeting.guildId,
      voiceChannelId: this.#meeting.voiceChannelId,
      title: this.#meeting.title,
      startedBy: this.#meeting.startedBy,
      startedAt: this.#meeting.startedAt.toISOString(),
      endedAt: endedAt?.toISOString() ?? null,
      audio: {
        container: 'wav',
        encoding: 'pcm_s16le',
        sampleRate: SAMPLE_RATE,
        channels: OUTPUT_CHANNELS,
      },
      participants,
      segments,
    };
  }

  /**
   * Queues a manifest write behind any write already running. The returned
   * promise rejects on failure, but the internal chain never does - one failed
   * write must not poison every write after it.
   */
  #persist(manifest: MeetingManifest): Promise<void> {
    const done = this.#save.then(() => writeManifest(this.#dir, manifest));
    this.#save = done.catch(() => {});
    return done;
  }
}

/**
 * One recorder per guild, mirroring how `getVoiceConnection` is keyed. Kept
 * out of the session store deliberately: that module is pure state and knows
 * nothing about audio.
 */
const recorders = new Map<string, MeetingRecorder>();

export async function startRecording(options: StartRecordingOptions): Promise<MeetingRecorder> {
  const recorder = new MeetingRecorder(options);

  // Register only once it is actually running, so a failed start leaves no
  // half-alive recorder behind for `stop` to find.
  await recorder.start();
  recorders.set(options.meeting.guildId, recorder);

  return recorder;
}

export function getRecorder(guildId: string): MeetingRecorder | undefined {
  return recorders.get(guildId);
}

/** Returns null when nothing was recording - stop and cancel both tolerate that. */
export async function stopRecording(guildId: string): Promise<MeetingManifest | null> {
  const recorder = recorders.get(guildId);
  if (!recorder) return null;

  recorders.delete(guildId);
  return recorder.stop();
}
