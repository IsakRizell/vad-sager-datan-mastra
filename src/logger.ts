import { appendFileSync } from 'node:fs';

const LOG_FILE = process.env.LOG_FILE ?? './app.log';

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, ev: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ev,
    ...(data ?? {}),
  });
  if (level === 'error') console.error(line);
  else console.log(line);
  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // Filen kanske inte är skrivbar (read-only FS i prod). Konsolen räcker.
  }
}

export const log = {
  info: (ev: string, data?: Record<string, unknown>) => emit('info', ev, data),
  warn: (ev: string, data?: Record<string, unknown>) => emit('warn', ev, data),
  error: (ev: string, data?: Record<string, unknown>) => emit('error', ev, data),
};

export function shortenSid(sid: string | null | undefined): string {
  return (sid ?? '???').slice(0, 8);
}
