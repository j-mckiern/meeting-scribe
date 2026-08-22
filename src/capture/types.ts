/**
 * The vocabulary everything downstream of capture speaks.
 *
 * Deliberately free of `discord.js` types: a segment is a mono WAV file on
 * disk with a speaker and a timestamp, and nothing about that has to change if
 * the audio later arrives from Zoom or Google Meet instead.
 */

export interface AudioFormat {
  container: 'wav';
  encoding: 'pcm_s16le';
  sampleRate: number;
  channels: number;
}

/** One uninterrupted burst of speech from one person, as a file on disk. */
export interface AudioSegment {
  /** Path relative to the meeting directory, e.g. `audio/00012480-1234.wav`. */
  file: string;
  userId: string;
  /**
   * The speaker's display name as it was at record time. Snapshotted because
   * people rename themselves and leave servers; a transcript that only stored
   * ids would become unreadable the moment someone did.
   */
  displayName: string;
  /** Offset from the start of the meeting to the start of this burst. */
  startMs: number;
  durationMs: number;
}

export interface Participant {
  userId: string;
  displayName: string;
}

/** Everything known about a meeting before a single byte is captured. */
export interface MeetingMeta {
  meetingId: string;
  guildId: string;
  voiceChannelId: string;
  title: string | null;
  startedBy: string;
  startedAt: Date;
}

/**
 * `manifest.json`. This is the contract between capture and transcription:
 * M2 reads a directory containing one of these and needs nothing else.
 *
 * It is rewritten after every completed burst rather than once at the end, so
 * a crash mid-meeting still leaves a usable recording behind. `endedAt` being
 * null is how you tell a crashed meeting from a finished one.
 */
export interface MeetingManifest {
  version: 1;
  meetingId: string;
  guildId: string;
  voiceChannelId: string;
  title: string | null;
  startedBy: string;
  startedAt: string;
  endedAt: string | null;
  audio: AudioFormat;
  /** Unique speakers, in first-heard order. Nobody silent appears here. */
  participants: Participant[];
  /** Sorted by startMs, so reading top to bottom replays the conversation. */
  segments: AudioSegment[];
}
