/**
 * The recording session state machine.
 *
 * There is at most one session per Discord server at a time. Modelling this
 * explicitly (rather than with a scatter of booleans) means every command has
 * exactly one question to ask: "is this transition legal right now?"
 *
 * Note there is no 'idle' member of Session['state']. Idle is represented by
 * the *absence* of a session in the store, so it is impossible to construct an
 * idle session object by mistake.
 */

export type SessionState = 'recording' | 'paused' | 'processing';

export interface Session {
  /** Stable id used for the on-disk directory: data/meetings/<meetingId>/ */
  meetingId: string;
  guildId: string;
  voiceChannelId: string;
  /** Where the bot replies with progress; the channel /meeting-scribe start was invoked in. */
  textChannelId: string;
  /** Optional human title from `/meeting-scribe start title:...`, used in the summary header. */
  title: string | null;
  /** Discord user id of whoever started it. */
  startedBy: string;
  startedAt: Date;
  state: SessionState;
}

/**
 * Which states you may move to from a given state.
 * `processing` is terminal: the only way out is ending the session entirely.
 */
const ALLOWED_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  recording: ['paused', 'processing'],
  paused: ['recording', 'processing'],
  processing: [],
};

/**
 * Thrown when a command is used in a state that doesn't allow it. The message
 * is written to be shown directly to the user, so it should never contain
 * internals or stack detail.
 */
export class SessionError extends Error {}

export class SessionStore {
  readonly #sessions = new Map<string, Session>();

  get(guildId: string): Session | undefined {
    return this.#sessions.get(guildId);
  }

  /** Same as get(), but throws a user-presentable error when nothing is running. */
  require(guildId: string): Session {
    const session = this.#sessions.get(guildId);
    if (!session) {
      throw new SessionError('No recording is in progress. Start one with `/meeting-scribe start`.');
    }
    return session;
  }

  start(input: Omit<Session, 'state' | 'startedAt' | 'meetingId'>): Session {
    if (this.#sessions.has(input.guildId)) {
      throw new SessionError(
        'A recording is already in progress in this server. Use `/meeting-scribe stop` or `/meeting-scribe cancel` first.',
      );
    }

    const startedAt = new Date();
    const session: Session = {
      ...input,
      meetingId: buildMeetingId(startedAt),
      startedAt,
      state: 'recording',
    };

    this.#sessions.set(input.guildId, session);
    return session;
  }

  transition(guildId: string, to: SessionState): Session {
    const session = this.require(guildId);

    if (!ALLOWED_TRANSITIONS[session.state].includes(to)) {
      throw new SessionError(
        `Can't go from \`${session.state}\` to \`${to}\`.`,
      );
    }

    session.state = to;
    return session;
  }

  /** Removes the session. Returns it so callers can log or clean up after it. */
  end(guildId: string): Session {
    const session = this.require(guildId);
    this.#sessions.delete(guildId);
    return session;
  }

  /** Used on shutdown to tear everything down cleanly. */
  all(): Session[] {
    return [...this.#sessions.values()];
  }
}

/**
 * e.g. "2026-08-19T14-32-05Z-a3f1" - sorts chronologically as a filename and
 * the suffix keeps two meetings started in the same second from colliding.
 */
function buildMeetingId(at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${stamp}-${suffix}`;
}

/** One shared instance for the whole process. */
export const sessions = new SessionStore();
