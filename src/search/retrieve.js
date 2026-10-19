/**
 * Retrieval = get candidate items from the database.
 *  - vectorSearch:  meaning-based (embedding + HNSW index, cosine distance <=>)
 *  - keywordSearch: word-based (tsvector + GIN index, ts_rank_cd)
 * Both apply the same metadata filters. Results are fused with RRF in pipeline.js.
 */
import { config } from '../config.js';
import { query, toVector, withTransaction } from '../db.js';
import { buildFilterSql } from './filters.js';

const COLS = 'id, external_id, title, category, genres, year, price, rating, body';
let iterativeScanSupported = null; // detected on first search

export async function vectorSearch(log, queryVec, filters, k) {
  const f = buildFilterSql(filters, 2);
  const sql = `
    SELECT ${COLS}, embedding <=> $1::vector AS distance
    FROM items
    WHERE embedding IS NOT NULL AND ${f.where}
    ORDER BY embedding <=> $1::vector
    LIMIT ${Number(k)}`;
  const params = [toVector(queryVec), ...f.params];

  if (k > config.hnsw.efSearch) {
    log.warn({ k, efSearch: config.hnsw.efSearch }, 'k > hnsw.ef_search: HNSW can return at most ef_search rows — raise HNSW_EF_SEARCH');
  }

  return withTransaction(log, async (q) => {
    // SET LOCAL only lives inside this transaction.
    await q(`SET LOCAL hnsw.ef_search = ${Number(config.hnsw.efSearch)}`, [], 'set ef_search');
    if (config.hnsw.iterativeScan && config.hnsw.iterativeScan !== 'off' && iterativeScanSupported !== false) {
      // A failed statement aborts the whole transaction in Postgres, so try it inside a SAVEPOINT.
      await q('SAVEPOINT iter', [], 'savepoint');
      try {
        await q(`SET LOCAL hnsw.iterative_scan = ${config.hnsw.iterativeScan}`, [], 'set iterative_scan', { expectFailure: true });
        iterativeScanSupported = true;
      } catch (err) {
        await q('ROLLBACK TO SAVEPOINT iter', [], 'rollback savepoint');
        iterativeScanSupported = false;
        log.warn({ reason: err.message }, 'hnsw.iterative_scan unsupported (needs pgvector >= 0.8) — filtered searches may return fewer rows. Won\'t retry.');
      }
    }

    if (config.log.explain) {
      const plan = await q(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params, 'explain vector');
      const lines = plan.rows.map((r) => r['QUERY PLAN']);
      const usesIndex = lines.some((l) => l.includes('items_embedding_hnsw'));
      log.info({ usesHnswIndex: usesIndex, plan: lines }, usesIndex ? 'EXPLAIN: HNSW index used' : 'EXPLAIN: sequential scan (normal for small tables; Postgres picks the cheapest plan)');
    }

    const { rows } = await q(sql, params, 'vector search');
    const items = rows.map((r) => ({ ...r, score: +(1 - r.distance).toFixed(4) })); // cosine similarity
    log.debug(
      { top: items.slice(0, 5).map((r) => ({ title: r.title, sim: r.score })), filtersApplied: f.applied },
      `vector search → ${items.length} rows`,
    );
    if (f.applied && items.length < k) {
      log.debug({ got: items.length, k }, 'fewer rows than k: filters are narrowing results (expected for small datasets)');
    }
    return items;
  });
}

const sanitize = (w) => w.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export async function keywordSearch(log, analysis, filters, k) {
  const terms = (analysis.keywords.length ? analysis.keywords : analysis.semantic_query.split(/\s+/))
    .map(sanitize)
    .filter((w) => w.length > 1);
  if (!terms.length) {
    log.debug('keyword search skipped: no usable terms');
    return [];
  }
  // OR the terms so one matching word is enough; ranking rewards matching more of them.
  const tsQuery = terms.join(' or ');
  const f = buildFilterSql(filters, 2);
  const sql = `
    SELECT ${COLS}, ts_rank_cd(body_tsv, websearch_to_tsquery('english', $1)) AS rank
    FROM items
    WHERE body_tsv @@ websearch_to_tsquery('english', $1) AND ${f.where}
    ORDER BY rank DESC
    LIMIT ${Number(k)}`;
  const { rows } = await query(log, sql, [tsQuery, ...f.params], 'keyword search');
  const items = rows.map((r) => ({ ...r, score: +Number(r.rank).toFixed(4) }));
  log.debug({ tsQuery, top: items.slice(0, 5).map((r) => ({ title: r.title, rank: r.score })) }, `keyword search → ${items.length} rows`);
  return items;
}
