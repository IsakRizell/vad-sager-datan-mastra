import { tool } from 'ai';
import { z } from 'zod';

const SCB_BASE = 'https://api.scb.se/OV0104/v1/doris/sv/ssd';

async function getNode(path: string): Promise<any> {
  const url = path ? `${SCB_BASE}/${path}` : SCB_BASE;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`SCB ${r.status} ${r.statusText} (path=${path})`);
  return r.json();
}

export const navigate = tool({
  description:
    "Lista barn-noder i SCB:s katalogträd. path='' ger 22 ämnesområden. " +
    "Varje barn har type 'l' (level — drilla djupare) eller 't' (tabell, queryable). " +
    'Drilla genom att appenda barnets id till path.',
  parameters: z.object({
    path: z.string().describe("T.ex. 'BE/BE0101' eller '' för roten."),
  }),
  execute: async ({ path }) => {
    const result = await getNode(path);
    return Array.isArray(result) ? result : [result];
  },
});

export const getTableMetadata = tool({
  description:
    'Hämta full metadata för en SCB-tabell: variabler, valueTexts, värdekoder, tidsdimension. ' +
    'Anropa ALLTID detta innan query_table — du behöver veta variabel-koderna.',
  parameters: z.object({
    table_id: z
      .string()
      .describe("Full slash-separerad path, t.ex. 'PR/PR0101/PR0101A/KPI2020M'."),
  }),
  execute: async ({ table_id }) => {
    return getNode(table_id);
  },
});

const selectionSchema = z.object({
  filter: z
    .string()
    .describe("'item' (specifika), 'all' (alla), eller 'top' (topp N)"),
  values: z.array(z.string()).describe('Lista av värdekoder.'),
});

const querySchema = z.object({
  code: z.string().describe("Variabelkod, t.ex. 'Tid', 'Region'."),
  selection: selectionSchema,
});

export const queryTable = tool({
  description:
    'Kör en PxWebApi-query mot en SCB-tabell. query är en lista av {code, selection}-objekt, ' +
    'ett per variabel att filtrera. Variabler du utelämnar får default-värden. SCB tar max ~150k celler per query.',
  parameters: z.object({
    table_id: z.string(),
    query: z.array(querySchema).describe('Lista av variabel-filter.'),
  }),
  execute: async ({ table_id, query }) => {
    const body = { query, response: { format: 'json' } };
    const r = await fetch(`${SCB_BASE}/${table_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`SCB query ${r.status}: ${text.slice(0, 300)}`);
    }
    return r.json();
  },
});

export const searchTables = tool({
  description:
    "BFS-sökning genom SCB:s katalogträd efter fritext. Returnerar tabeller vars id eller text matchar keyword.",
  parameters: z.object({
    keyword: z.string().describe('Sökord (case-insensitive).'),
    start_path: z
      .string()
      .optional()
      .default('')
      .describe("Starta sökningen under specifik nod, t.ex. 'PR/PR0101'. Tom = roten."),
    max_results: z.number().int().optional().default(30),
    max_depth: z.number().int().optional().default(6),
  }),
  execute: async ({ keyword, start_path, max_results, max_depth }) => {
    const needle = keyword.toLowerCase();
    const mr = max_results ?? 30;
    const md = max_depth ?? 6;
    const results: Array<{ id: string; path: string; text: string }> = [];
    const queue: Array<[string, number]> = [[start_path ?? '', 0]];

    while (queue.length && results.length < mr) {
      const [path, depth] = queue.shift()!;
      let children: any;
      try {
        children = await getNode(path);
      } catch {
        continue;
      }
      if (!Array.isArray(children)) continue;
      for (const child of children) {
        const cid: string = child.id ?? '';
        const cpath = path ? `${path}/${cid}` : cid;
        const text: string = child.text ?? '';
        if (child.type === 't') {
          if (text.toLowerCase().includes(needle) || cid.toLowerCase().includes(needle)) {
            results.push({ id: cid, path: cpath, text });
            if (results.length >= mr) break;
          }
        } else if (child.type === 'l' && depth < md) {
          queue.push([cpath, depth + 1]);
        }
      }
    }
    return results;
  },
});
