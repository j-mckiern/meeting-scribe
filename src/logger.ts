import { config } from './config.js';

/**
 * Deliberately tiny. Everything goes to stdout so `docker compose logs -f`
 * is the whole observability story for now.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[config.LOG_LEVEL];

function emit(level: Level, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;

  if (extra === undefined) {
    console.log(line);
  } else {
    console.log(line, extra);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit('debug', msg, extra),
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
};
