import { tool } from 'ai';
import { z } from 'zod';

function stripHtml(html: string): { text: string; title: string } {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return { text, title };
}

const MAX_CHARS = 6000;

export const fetchUrl = tool({
  description:
    'Hämta innehållet på en URL (artikel, pressmeddelande, regeringen.se, riksbanken.se, mm). ' +
    'Extraherar text, returnerar titel + första ~6000 tecken. ' +
    'Funkar INTE för Twitter/X-tweets, be om screenshot istället.',
  parameters: z.object({
    url: z.string().describe('Hela URL:en, inkl. https://'),
  }),
  execute: async ({ url }, opts) => {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
        signal: opts?.abortSignal,
      });
      if (!r.ok) {
        return { url, error: `HTTP ${r.status} ${r.statusText}` };
      }
      const html = await r.text();
      const { text, title } = stripHtml(html);
      const truncated = text.length > MAX_CHARS;
      return {
        url: r.url,
        title,
        text: truncated ? text.slice(0, MAX_CHARS) + '\n\n[…trunkerat]' : text,
        truncated,
        full_length: text.length,
      };
    } catch (err: any) {
      return { url, error: err?.message ?? String(err) };
    }
  },
});
