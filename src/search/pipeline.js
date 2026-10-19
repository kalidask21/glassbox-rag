/**
 * The whole search flow, one function:
 *
 *   query ─► analyze ─► embed ─┬─► vector search ─┐
 *                              └─► keyword search ─┴─► RRF fuse ─► rerank ─► results
 *
 * The two retrievers come from the chosen backend (postgres | elastic). Everything else is shared.
 * `analysis` and `queryVec` can be passed in to skip those stages (the compare script runs the
 * LLM analyzer and the embedding once, then reuses them for both backends).
 *
 * Returns results plus a `trace` (per-stage timings) and `debug` details you can
 * get from the API with "debug": true.
 */
import { config } from '../config.js';
import { createTrace } from '../logger.js';
import { embed } from '../llm/ollama.js';
import { analyzeQuery } from './queryAnalyzer.js';
import { getBackend } from './backends.js';
import { rrfFuse } from './fusion.js';
import { rerank } from './rerank.js';

const publicItem = (it) => ({
  id: it.external_id,
  title: it.title,
  category: it.category,
  genres: it.genres,
  year: it.year,
  price: it.price === null ? null : Number(it.price),
  rating: it.rating === null ? null : Number(it.rating),
  snippet: it.body.length > 220 ? `${it.body.slice(0, 220)}…` : it.body,
  scores: { rrf: it.rrf, rerank: it.rerankScore, sources: it.sources },
});

export async function runSearch(
  log,
  rawQuery,
  { finalK = config.search.finalK, backend = config.searchBackend, analysis: given, queryVec: givenVec } = {},
) {
  const trace = createTrace(log);
  const candidateK = config.search.candidateK;
  const { vectorSearch, keywordSearch } = getBackend(backend);
  log = log.child({ backend });
  log.info({ query: rawQuery, candidateK, finalK }, '🔎 search start');

  const analysis = given ?? (await analyzeQuery(log, rawQuery, trace));

  if (analysis.intent === 'chitchat') {
    log.info('intent=chitchat → skipping retrieval');
    return { analysis, results: [], trace: { stages: trace.stages, totalMs: trace.totalMs() } };
  }

  // Embed the *semantic* part only (filters were pulled out by the analyzer).
  let s;
  let queryVec = givenVec;
  if (!queryVec) {
    s = trace.stage('embed-query');
    [queryVec] = await embed(log, [analysis.semantic_query], { kind: 'query' });
    s.end({ dim: queryVec.length });
  }

  // Run both retrievers in parallel.
  s = trace.stage('retrieve', { backend });
  const [vec, kw] = await Promise.all([
    vectorSearch(log, queryVec, analysis.filters, candidateK),
    keywordSearch(log, analysis, analysis.filters, candidateK),
  ]);
  s.end({ backend, vector: vec.length, keyword: kw.length });

  if (!vec.length && !kw.length && Object.keys(analysis.filters).length) {
    log.warn({ filters: analysis.filters }, '0 results WITH filters — filters may be too strict (try ANALYZER_MODE=off to compare)');
  }

  s = trace.stage('fuse');
  const fused = rrfFuse(
    [
      { name: 'vector', items: vec },
      { name: 'keyword', items: kw },
    ],
    config.search.rrfK,
  );
  const both = fused.filter((f) => f.sources.vector && f.sources.keyword).length;
  log.debug(
    { top: fused.slice(0, 8).map((f) => ({ title: f.title, rrf: f.rrf, v: f.sources.vector?.rank ?? '-', k: f.sources.keyword?.rank ?? '-' })) },
    'fused ranking (v/k = rank in vector/keyword list)',
  );
  s.end({ unique: fused.length, inBothLists: both });

  const reranked = await rerank(log, analysis.semantic_query, fused.slice(0, candidateK), finalK, trace);

  const results = reranked.map(publicItem);
  const totalMs = trace.totalMs();
  log.info({ results: results.length, totalMs, top: results[0]?.title ?? null }, '🔎 search done');

  return {
    backend,
    analysis,
    queryVec,
    results,
    raw: reranked, // full rows, used to build the LLM context
    trace: { stages: trace.stages, totalMs },
  };
}
