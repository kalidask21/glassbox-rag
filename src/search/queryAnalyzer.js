/**
 * Query analyzer: raw user text -> structured intent.
 *
 *   "funny space movies from the 2010s"
 *     -> { intent: "search",
 *          semantic_query: "funny space movies",
 *          keywords: ["space"],
 *          filters: { genres: ["comedy","science fiction"], year_min: 2010, year_max: 2019 } }
 *
 * Two layers:
 *  1. rules (regex)  — fast, exact, deterministic
 *  2. LLM (Llama)    — understands synonyms/intent, returns JSON constrained by a schema
 * Rules win on conflicts. LLM genres are checked against genres that really exist in
 * the DB; unknown ones are dropped (and logged) because a bad filter returns zero rows.
 */
import { config } from '../config.js';
import { query } from '../db.js';
import { chatJson } from '../llm/ollama.js';
import { ruleBasedParse } from './rules.js';

const SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['search', 'question', 'chitchat'] },
    semantic_query: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    filters: {
      type: 'object',
      properties: {
        genres: { type: 'array', items: { type: 'string' } },
        category: { type: 'string' },
        year_min: { type: 'integer' },
        year_max: { type: 'integer' },
        price_min: { type: 'number' },
        price_max: { type: 'number' },
        rating_min: { type: 'number' },
      },
    },
  },
  required: ['intent', 'semantic_query', 'keywords', 'filters'],
};

let knownGenresCache = null;
async function knownGenres(log) {
  if (knownGenresCache) return knownGenresCache;
  const { rows } = await query(log, 'SELECT DISTINCT unnest(genres) AS g FROM items ORDER BY 1', [], 'known-genres');
  knownGenresCache = rows.map((r) => r.g);
  log.debug({ count: knownGenresCache.length, genres: knownGenresCache }, 'loaded known genres/tags for analyzer');
  return knownGenresCache;
}
export const resetGenreCache = () => (knownGenresCache = null);

function systemPrompt(genres) {
  return `You convert a shopping/search query into JSON for a search engine.
Fields:
- intent: "search" (find items), "question" (asks about items), "chitchat" (not about items).
- semantic_query: the descriptive meaning to match, WITHOUT filter words like years or prices.
- keywords: important exact words (names, titles, brands). Can be empty.
- filters: ONLY constraints the user clearly stated. Omit a field if not stated.
  genres must be chosen from this list (lowercase), otherwise omit: ${genres.join(', ') || '(none)'}
Do not invent filters.`;
}

const cleanNum = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

export async function analyzeQuery(log, rawQuery, trace) {
  const s = trace.stage('analyze', { mode: config.analyzerMode });
  const rules = ruleBasedParse(rawQuery);
  log.debug({ rules }, 'rule-based parse');

  const base = { intent: 'search', semantic_query: rules.semantic, keywords: [], filters: { ...rules.filters }, source: 'rules' };
  if (config.analyzerMode === 'off') {
    const out = { intent: 'search', semantic_query: rawQuery, keywords: [], filters: {}, source: 'off' };
    s.end({ source: 'off' });
    return out;
  }
  if (config.analyzerMode === 'rules') {
    s.end({ source: 'rules', filters: Object.keys(base.filters).length });
    return base;
  }

  try {
    const genres = await knownGenres(log);
    const llm = await chatJson(
      log,
      [
        { role: 'system', content: systemPrompt(genres) },
        { role: 'user', content: rawQuery },
      ],
      SCHEMA,
      'llm:analyze',
    );
    log.debug({ llm }, 'LLM analyzer raw result');

    const f = llm.filters ?? {};
    const llmGenres = (f.genres ?? []).map((g) => String(g).toLowerCase());
    const validGenres = llmGenres.filter((g) => genres.includes(g));
    const dropped = llmGenres.filter((g) => !genres.includes(g));
    if (dropped.length) log.warn({ dropped, valid: validGenres }, 'analyzer proposed genres that do not exist in DB — dropped');

    const merged = {
      intent: llm.intent ?? 'search',
      semantic_query: (llm.semantic_query || rules.semantic || rawQuery).trim(),
      keywords: (llm.keywords ?? []).filter(Boolean),
      filters: {
        ...(validGenres.length && { genres: validGenres }),
        ...(f.category && { category: f.category }),
        ...Object.fromEntries(
          ['year_min', 'year_max', 'price_min', 'price_max', 'rating_min']
            .map((k) => [k, cleanNum(f[k])])
            .filter(([, v]) => v !== undefined),
        ),
        ...rules.filters, // rules override the LLM
      },
      source: 'llm+rules',
    };
    log.info({ analysis: merged }, 'query analyzed');
    s.end({ source: merged.source, intent: merged.intent, filters: Object.keys(merged.filters).length });
    return merged;
  } catch (err) {
    log.warn({ err: err.message }, 'LLM analyzer failed — falling back to rules only');
    s.end({ source: 'rules-fallback' });
    return { ...base, source: 'rules-fallback' };
  }
}
