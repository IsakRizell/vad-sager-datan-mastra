import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';

import { streamText, type CoreMessage } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

import { INSTRUCTIONS } from './instructions.js';
import { searchTables, navigate, getTableMetadata, queryTable } from './tools/scb.js';
import { fetchUrl } from './tools/web.js';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY saknas — sätt i .env');
  process.exit(1);
}

const SID_COOKIE = 'vsd_sid';
const SID_MAX_AGE = 60 * 60 * 24;
const MODEL = anthropic('claude-sonnet-4-6');
const TOOLS = { searchTables, navigate, getTableMetadata, queryTable, fetchUrl };
const MAX_STEPS = 15;
const MAX_HISTORY_MESSAGES = 30;

// Per-session: kvar konversationshistorik (CoreMessage[]) + AbortController.
type Session = {
  history: CoreMessage[];
  abort: AbortController | null;
};
const sessions = new Map<string, Session>();

function getSession(sid: string): Session {
  let s = sessions.get(sid);
  if (!s) {
    s = { history: [], abort: null };
    sessions.set(sid, s);
  }
  return s;
}

const app = new Hono();
// Läs HTML på varje request i dev (gör CSS-iteration snabb).
// I prod (NODE_ENV=production) cachar vi en gång.
let cachedHtml: string | null = null;
function indexHtml(): string {
  if (process.env.NODE_ENV === 'production') {
    if (!cachedHtml) cachedHtml = readFileSync(resolve('public/index.html'), 'utf8');
    return cachedHtml;
  }
  return readFileSync(resolve('public/index.html'), 'utf8');
}
app.get('/', (c) => c.html(indexHtml()));

app.post('/chat', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    message?: string;
    images?: string[];
  };
  const message = (body.message ?? '').trim();
  const images = Array.isArray(body.images) ? body.images.filter((s) => typeof s === 'string') : [];
  if (!message && images.length === 0) return c.json({ detail: 'Tomt meddelande.' }, 400);
  if (message.length > 8000) return c.json({ detail: 'Meddelandet är för långt.' }, 400);
  if (images.length > 6) return c.json({ detail: 'För många bilder (max 6).' }, 400);

  let sid = getCookie(c, SID_COOKIE);
  if (!sid) {
    sid = randomBytes(16).toString('hex');
    setCookie(c, SID_COOKIE, sid, {
      maxAge: SID_MAX_AGE,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
  }

  const session = getSession(sid);
  session.abort?.abort();
  const ac = new AbortController();
  session.abort = ac;

  // Bygg user-message — text och/eller bilder.
  const userContent: CoreMessage['content'] =
    images.length === 0
      ? message
      : [
          ...(message ? [{ type: 'text' as const, text: message }] : []),
          ...images.map((img) => {
            const b64 = img.startsWith('data:') ? img.split(',')[1] : img;
            const ctMatch = img.startsWith('data:') ? img.match(/^data:([^;]+);/) : null;
            const mimeType = ctMatch?.[1] ?? 'image/jpeg';
            return {
              type: 'image' as const,
              image: new Uint8Array(Buffer.from(b64, 'base64')),
              mimeType,
            };
          }),
        ];

  const userMessage: CoreMessage = { role: 'user', content: userContent };
  const messagesForCall = [...session.history, userMessage];

  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) =>
      stream.writeSSE({ event, data: JSON.stringify(data) });

    try {
      const today = new Date().toLocaleDateString('sv-SE');
      const result = streamText({
        model: MODEL,
        system: `${INSTRUCTIONS}\n\n# Dagens datum\n${today}. Antag inte att senare datum än så ligger "i framtiden" — kolla alltid SCB om du är osäker.`,
        tools: TOOLS,
        messages: messagesForCall,
        maxSteps: MAX_STEPS,
        temperature: 0.3,
        abortSignal: ac.signal,
      });

      for await (const part of result.fullStream) {
        if (ac.signal.aborted) break;
        // Tool execution errors hanteras av agenten själv (den får ett
        // tool_result med felmeddelandet och kan välja nästa drag). Vi
        // loggar serverside men spammar inte klienten.
        if (part.type === 'error') {
          try { console.error('[stream-error]', JSON.stringify(part.error).slice(0, 500)); }
          catch { console.error('[stream-error]', String(part.error).slice(0, 500)); }
          continue;
        }
        await send(part.type, part);
      }

      if (ac.signal.aborted) {
        await send('interrupted', 'Stoppad av användare.');
        return;
      }

      // Spara user-message + agent-response till historik.
      const responseMessages = (await result.response).messages;
      session.history = [...session.history, userMessage, ...responseMessages];
      // Cap historiken så vi inte sväller obegränsat.
      if (session.history.length > MAX_HISTORY_MESSAGES) {
        session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
      }

      await send('done', '');
    } catch (err: any) {
      if (err?.name === 'AbortError' || ac.signal.aborted) {
        await send('interrupted', 'Stoppad av användare.');
      } else {
        await send('error', `Agent-fel: ${err?.message ?? String(err)}`);
      }
    } finally {
      if (session.abort === ac) session.abort = null;
    }
  });
});

app.post('/stop', async (c) => {
  const sid = getCookie(c, SID_COOKIE);
  const session = sid ? sessions.get(sid) : null;
  if (session?.abort) {
    session.abort.abort();
    return c.json({ ok: true });
  }
  return c.json({ ok: false });
});

app.post('/reset', async (c) => {
  const sid = getCookie(c, SID_COOKIE);
  if (sid) {
    sessions.get(sid)?.abort?.abort();
    sessions.delete(sid);
  }
  deleteCookie(c, SID_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

const port = Number(process.env.PORT ?? 8766);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`✓ Vad säger datan på http://localhost:${info.port}`);
});
