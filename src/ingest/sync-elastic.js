/**
 * Copy rows (including their embeddings) from Postgres into Elasticsearch.
 *
 * This is the usual production pattern: Postgres is the source of truth,
 * Elastic is a search index you can always rebuild from it. No re-embedding needed.
 *
 *   npm run sync:elastic               # create index if missing, upsert all rows
 *   npm run sync:elastic -- --recreate # delete and rebuild the index (after mapping changes)
 *   npm run sync:elastic -- --batch 200
 */
import { config } from '../config.js';
import { flushLogs, logger, startTimer } from '../logger.js';
import { pool, query } from '../db.js';
import { esRequest } from '../elastic.js';
import { indexDefinition } from '../search/elasticQuery.js';

const args = process.argv.slice(2);
const recreate = args.includes('--recreate');
const bi = args.indexOf('--batch');
const batchSize = bi >= 0 ? Number(args[bi + 1]) : 500;

const log = logger.child({ reqId: 'sync-es' });
const { index } = config.elastic;

async function ensureIndex() {
  const exists = await esRequest(log, 'HEAD', `/${index}`, undefined, { label: 'index exists?', allow404: true }).catch(() => null);
  if (exists && recreate) {
    await esRequest(log, 'DELETE', `/${index}`, undefined, { label: 'delete index' });
    log.warn({ index }, 'index deleted (--recreate)');
  }
  if (!exists || recreate) {
    await esRequest(log, 'PUT', `/${index}`, indexDefinition(config.embedDim), { label: 'create index' });
    log.info({ index, dims: config.embedDim }, 'index created with mapping');
  } else {
    log.info({ index }, 'index exists — upserting (use --recreate after mapping changes)');
  }
}

/** NDJSON: an action line, then the document line, for every row. Must end with "\n". */
function toBulk(rows) {
  return (
    rows
      .flatMap((r) => [
        JSON.stringify({ index: { _index: index, _id: r.external_id } }),
        JSON.stringify({
          external_id: r.external_id,
          title: r.title,
          body: r.body,
          category: r.category,
          genres: r.genres,
          year: r.year,
          price: r.price === null ? null : Number(r.price),
          rating: r.rating === null ? null : Number(r.rating),
          embedding: JSON.parse(r.embedding), // pgvector returns "[0.1,0.2,...]"
        }),
      ])
      .join('\n') + '\n'
  );
}

async function main() {
  const total = startTimer(log, 'sync-elastic', { index, batchSize, recreate });
  await ensureIndex();

  let lastId = 0;
  let sent = 0;
  let failed = 0;
  for (;;) {
    // Keyset pagination (WHERE id > last) stays fast on huge tables, unlike OFFSET.
    const { rows } = await query(
      log,
      `SELECT id, external_id, title, body, category, genres, year, price, rating, embedding::text AS embedding
       FROM items WHERE id > $1 AND embedding IS NOT NULL ORDER BY id LIMIT $2`,
      [lastId, batchSize],
      'read batch',
    );
    if (!rows.length) break;
    lastId = rows.at(-1).id;

    const t = startTimer(log, 'bulk', { rows: rows.length, upToId: lastId });
    const res = await esRequest(log, 'POST', '/_bulk', toBulk(rows), { label: 'bulk index', ndjson: true });
    // _bulk returns 200 even if some documents failed — always check `errors`.
    const errs = res.errors ? res.items.filter((i) => i.index?.error) : [];
    if (errs.length) {
      failed += errs.length;
      log.error({ count: errs.length, first: errs.slice(0, 3).map((e) => ({ id: e.index._id, error: e.index.error.reason })) }, 'bulk: some documents failed');
    }
    sent += rows.length - errs.length;
    t.end({ ok: rows.length - errs.length, failed: errs.length });
  }

  // Make new docs searchable now (Elastic normally refreshes every 1s).
  await esRequest(log, 'POST', `/${index}/_refresh`, undefined, { label: 'refresh' });
  const es = await esRequest(log, 'GET', `/${index}/_count`, undefined, { label: 'count' });
  const pg = await query(log, 'SELECT count(*)::int AS n FROM items WHERE embedding IS NOT NULL', [], 'pg count');

  total.end({ indexed: sent, failed, elasticCount: es.count, postgresCount: pg.rows[0].n });
  if (es.count !== pg.rows[0].n) {
    log.warn({ elastic: es.count, postgres: pg.rows[0].n }, 'counts differ — stale docs in Elastic? run with --recreate');
  }
}

main()
  .catch((err) => {
    log.fatal({ err }, 'sync failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    await flushLogs();
  });
