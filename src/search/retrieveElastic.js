/**
 * Elasticsearch retrievers with the SAME signatures and row shape as retrieve.js,
 * so the rest of the pipeline (RRF, rerank, answer) doesn't change at all.
 */
import { config } from '../config.js';
import { esRequest } from '../elastic.js';
import { facetsBody, keywordBody, knnBody } from './elasticQuery.js';

const toRow = (hit, score) => ({
  ...hit._source,
  id: hit._id, // RRF merges by id; in Elastic the doc id is the external_id
  external_id: hit._id,
  score,
});

export async function vectorSearch(log, queryVec, filters, k) {
  const { index, numCandidates } = config.elastic;
  if (k > numCandidates) log.warn({ k, numCandidates }, 'k > ELASTIC_NUM_CANDIDATES — raise it for better recall');

  const data = await esRequest(log, 'POST', `/${index}/_search`, knnBody(queryVec, filters, k, numCandidates), { label: 'es knn search' });
  // For cosine, Elastic scores = (1 + cos) / 2 so they're never negative. Convert back to cosine
  // so the numbers are directly comparable with the Postgres logs.
  const items = data.hits.hits.map((h) => toRow(h, +(2 * h._score - 1).toFixed(4)));
  log.debug(
    { top: items.slice(0, 5).map((r) => ({ title: r.title, sim: r.score })), tookMs: data.took },
    `es vector search → ${items.length} rows (filters applied during the graph walk)`,
  );
  return items;
}

export async function keywordSearch(log, analysis, filters, k) {
  const text = [analysis.semantic_query, ...analysis.keywords].join(' ').trim();
  if (!text) return [];
  const data = await esRequest(log, 'POST', `/${config.elastic.index}/_search`, keywordBody(text, filters, k), { label: 'es keyword search' });
  const items = data.hits.hits.map((h) => toRow(h, +h._score.toFixed(4)));
  log.debug(
    { text, top: items.slice(0, 5).map((r) => ({ title: r.title, bm25: r.score })), tookMs: data.took },
    `es keyword search (BM25 + fuzzy) → ${items.length} rows`,
  );
  return items;
}

/** Facet counts — the thing Elastic does that this Postgres setup doesn't. */
export async function facets(log, filters) {
  const data = await esRequest(log, 'POST', `/${config.elastic.index}/_search`, facetsBody(filters), { label: 'es facets' });
  const a = data.aggregations;
  const out = {
    genres: a.genres.buckets.map((b) => ({ value: b.key, count: b.doc_count })),
    categories: a.categories.buckets.map((b) => ({ value: b.key, count: b.doc_count })),
    decades: a.decades.buckets.map((b) => ({ value: `${b.key}s`, count: b.doc_count })),
    price: a.price.buckets.filter((b) => b.doc_count).map((b) => ({ value: b.key, count: b.doc_count })),
  };
  log.debug({ facets: out }, 'es facets');
  return out;
}
