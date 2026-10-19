/**
 * Load a JSON array, embed each record, upsert into Postgres.
 *
 *   npm run ingest                              # data/movies.json
 *   npm run ingest -- data/products.sample.json
 *   npm run ingest -- data/movies.json --reset  # TRUNCATE first
 *   npm run ingest -- data/movies.json --limit 5 --dry-run
 *   npm run ingest -- data/movies.json --batch 32
 */
import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { flushLogs, logger, preview, startTimer } from '../logger.js';
import { pool, query, toVector } from '../db.js';
import { embed } from '../llm/ollama.js';
import { toItem } from './mapping.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const file = args.find((a, i) => !a.startsWith('--') && !['--limit', '--batch'].includes(args[i - 1])) ?? 'data/movies.json';
const limit = Number(opt('limit', Infinity));
const batchSize = Number(opt('batch', 16));
const dryRun = flag('dry-run');

const log = logger.child({ reqId: 'ingest' });

const UPSERT = `
  INSERT INTO items (external_id, title, category, genres, year, price, rating, doc, body, embedding)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)
  ON CONFLICT (external_id) DO UPDATE SET
    title = EXCLUDED.title, category = EXCLUDED.category, genres = EXCLUDED.genres,
    year = EXCLUDED.year, price = EXCLUDED.price, rating = EXCLUDED.rating,
    doc = EXCLUDED.doc, body = EXCLUDED.body, embedding = EXCLUDED.embedding
  RETURNING (xmax = 0) AS inserted`;

async function main() {
  const total = startTimer(log, 'ingest', { file, batchSize, dryRun });
  log.info({ embedModel: config.embedModel, dim: config.embedDim, docPrefix: JSON.stringify(config.embedDocPrefix) }, 'ingest config');

  const raw = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${file} must contain a JSON array`);
  const records = raw.slice(0, limit);
  log.info({ records: records.length, inFile: raw.length }, 'loaded JSON');

  // 1) Map records -> rows
  const items = [];
  let skipped = 0;
  records.forEach((rec, i) => {
    const { item, skip } = toItem(rec);
    if (skip) {
      skipped++;
      log.warn({ index: i, reason: skip, record: preview(JSON.stringify(rec), 200) }, 'skipping record');
      return;
    }
    log.trace({ index: i, item: { ...item, doc: undefined } }, 'mapped record');
    items.push(item);
  });
  log.info({ mapped: items.length, skipped }, 'mapping done');
  if (items[0]) log.debug({ example: { title: items[0].title, genres: items[0].genres, body: preview(items[0].body, 300) } }, 'example of what gets embedded');

  if (dryRun) {
    log.info('dry run: no embeddings, no DB writes');
    return;
  }

  if (flag('reset')) {
    await query(log, 'TRUNCATE items RESTART IDENTITY', [], 'truncate');
    log.warn('items table truncated');
  }

  // 2) Embed + upsert in batches
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const bt = startTimer(log, 'batch', { from: i, to: i + batch.length - 1 });
    const vectors = await embed(log, batch.map((it) => it.body), { kind: 'document' });

    for (let j = 0; j < batch.length; j++) {
      const it = batch[j];
      const res = await query(
        log,
        UPSERT,
        [it.externalId, it.title, it.category, it.genres, it.year, it.price, it.rating, JSON.stringify(it.doc), it.body, toVector(vectors[j])],
        `upsert:${it.externalId}`,
      );
      res.rows[0].inserted ? inserted++ : updated++;
    }
    bt.end({ done: Math.min(i + batchSize, items.length), of: items.length });
  }

  // 3) Sanity check
  const { rows } = await query(log, 'SELECT count(*)::int AS n, count(embedding)::int AS with_vec FROM items', [], 'count');
  const ms = total.end({ inserted, updated, skipped, tableRows: rows[0].n, withEmbedding: rows[0].with_vec });
  log.info({ perItemMs: items.length ? +(ms / items.length).toFixed(1) : 0 }, 'throughput');
}

main()
  .catch((err) => {
    log.fatal({ err }, 'ingest failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    await flushLogs();
  });
