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
import { log, shortenSid } from './logger.js';

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
const htmlCache = new Map<string, string>();
function readHtml(name: string): string {
  if (process.env.NODE_ENV === 'production') {
    if (!htmlCache.has(name)) htmlCache.set(name, readFileSync(resolve(`public/${name}`), 'utf8'));
    return htmlCache.get(name)!;
  }
  return readFileSync(resolve(`public/${name}`), 'utf8');
}
app.get('/', (c) => c.html(readHtml('index.html')));
app.get('/tips', (c) => c.html(readHtml('tips.html')));
app.get('/om', (c) => c.html(readHtml('om.html')));

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

  const sidShort = shortenSid(sid);
  const turnStart = Date.now();
  // PRIVACY: vi loggar aldrig användarens meddelande, varken text, längd eller
  // tool-args. Bara teknik-metrik som vi behöver för felsökning och kostnadskoll.
  log.info('chat_start', {
    sid: sidShort,
    has_text: message.length > 0,
    images: images.length,
    history_len: session.history.length,
  });

  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) =>
      stream.writeSSE({ event, data: JSON.stringify(data) });

    let stepCount = 0;
    let toolCallCount = 0;
    let toolErrorCount = 0;
    let textChars = 0;

    try {
      const today = new Date().toLocaleDateString('sv-SE');
      const result = streamText({
        model: MODEL,
        system: `${INSTRUCTIONS}\n\n# Dagens datum\n${today}. Antag inte att senare datum än så ligger "i framtiden". Kolla alltid SCB om du är osäker.`,
        tools: TOOLS,
        messages: messagesForCall,
        maxSteps: MAX_STEPS,
        temperature: 0.3,
        abortSignal: ac.signal,
      });

      for await (const part of result.fullStream) {
        if (ac.signal.aborted) break;

        if (part.type === 'error') {
          // PRIVACY: part.error kan innehålla toolArgs eller hela API-payloaden.
          // Logga bara error-namnet och eventuell tool som triggade det.
          const errAny: any = part.error;
          log.error('stream_error', {
            sid: sidShort,
            error_name: errAny?.name ?? 'Error',
            tool: errAny?.toolName,
          });
          continue;
        }

        if (part.type === 'step-start') stepCount++;
        if (part.type === 'tool-call') {
          toolCallCount++;
          // PRIVACY: bara verktygsnamnet, inte arg (kan avslöja vad användaren undersöker).
          log.info('tool_call', { sid: sidShort, tool: part.toolName });
        }
        if (part.type === 'tool-result') {
          const r: any = part.result;
          const failed = r && typeof r === 'object' && r.ok === false;
          if (failed) toolErrorCount++;
          // PRIVACY: ingen preview, bara tool-namn och om det gick.
          log.info('tool_result', { sid: sidShort, tool: part.toolName, ok: !failed });
        }
        if (part.type === 'text-delta') textChars += (part.textDelta ?? '').length;

        await send(part.type, part);
      }

      if (ac.signal.aborted) {
        log.info('chat_interrupted', { sid: sidShort, dur_ms: Date.now() - turnStart, steps: stepCount, tools: toolCallCount });
        await send('interrupted', 'Stoppad av användare.');
        return;
      }

      const finalResp = await result.response;
      session.history = [...session.history, userMessage, ...finalResp.messages];
      if (session.history.length > MAX_HISTORY_MESSAGES) {
        session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
      }

      const usage = await result.usage.catch(() => null);
      log.info('chat_done', {
        sid: sidShort,
        dur_ms: Date.now() - turnStart,
        steps: stepCount,
        tools: toolCallCount,
        tool_errors: toolErrorCount,
        in_tokens: usage?.promptTokens,
        out_tokens: usage?.completionTokens,
      });

      await send('done', '');
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // PRIVACY: error-meddelandet kan innehålla request-payload (system prompt +
      // user message). Logga bara felnamn/typ, inte meddelandet.
      log.error('chat_error', {
        sid: sidShort,
        dur_ms: Date.now() - turnStart,
        steps: stepCount,
        tools: toolCallCount,
        error_name: err?.name ?? 'Error',
      });
      if (err?.name === 'AbortError' || ac.signal.aborted) {
        await send('interrupted', 'Stoppad av användare.');
      } else if (msg.includes('tool_use') && msg.includes('tool_result')) {
        session.history = [];
        log.warn('session_corrupted_reset', { sid: sidShort });
        await send('error', 'Konversationen blev korrupt från ett tidigare fel. Rensade minnet, skicka frågan igen.');
      } else {
        await send('error', `Agent-fel: ${msg}`);
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
    log.info('session_reset', { sid: shortenSid(sid) });
  }
  deleteCookie(c, SID_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// Simple log-viewer för dev. Visar senaste N rader från ./app.log som pretty text.
app.get('/logs', async (c) => {
  const { readFileSync } = await import('node:fs');
  const limit = Math.min(500, Number(c.req.query('n') ?? 200));
  let raw = '';
  try {
    raw = readFileSync(process.env.LOG_FILE ?? './app.log', 'utf8');
  } catch {
    return c.text('(ingen logg-fil än)', 200);
  }
  const lines = raw.trim().split('\n').slice(-limit);
  const pretty = lines.map((l) => {
    try {
      const o = JSON.parse(l);
      const { ts, level, ev, ...rest } = o;
      const time = String(ts).slice(11, 19);
      return `${time}  ${level.padEnd(5)} ${ev.padEnd(22)} ${JSON.stringify(rest)}`;
    } catch {
      return l;
    }
  }).join('\n');
  return c.text(pretty, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
});

const port = Number(process.env.PORT ?? 8766);
serve({ fetch: app.fetch, port }, (info) => {
  log.info('server_start', { port: info.port, node_env: process.env.NODE_ENV ?? 'dev' });
  console.log(`✓ Ärligt talat på http://localhost:${info.port}`);
  console.log(`  Logs: tail -f app.log  |  http://localhost:${info.port}/logs`);
});
