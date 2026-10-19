/**
 * Postgres access with logging on every statement.
 * LOG_SQL=true logs SQL + params at debug level; vectors are summarized as <vector dim=N>.
 */
import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

pool.on('connect', () => logger.trace('pg: new pooled connection'));
pool.on('error', (err) => logger.error({ err }, 'pg: idle client error'));

/** JS number[] -> pgvector literal "[0.1,0.2,...]" */
export const toVector = (arr) => `[${arr.join(',')}]`;

const compactSql = (s) => s.replace(/\s+/g, ' ').trim();
const summarizeParam = (p) => {
  if (typeof p === 'string' && p.startsWith('[') && p.length > 200) {
    return `<vector dim=${p.split(',').length}>`;
  }
  if (typeof p === 'string' && p.length > 200) return `${p.slice(0, 200)}…`;
  return p;
};

async function run(executor, log, text, params, label, { expectFailure = false } = {}) {
  const start = performance.now();
  if (config.log.sql) {
    log.debug({ label, sql: compactSql(text), params: params.map(summarizeParam) }, `SQL → ${label}`);
  }
  try {
    const res = await executor.query(text, params);
    const ms = +(performance.now() - start).toFixed(1);
    log.debug({ label, rows: res.rowCount, ms }, `SQL ← ${label}`);
    if (ms > 500) log.warn({ label, ms }, 'slow query (>500ms) — try LOG_EXPLAIN=true');
    return res;
  } catch (err) {
    // expectFailure: caller handles it (e.g. feature detection), so don't log as an error
    log[expectFailure ? 'debug' : 'error']({ err, label, sql: compactSql(text), params: params.map(summarizeParam) }, `SQL failed: ${label}`);
    throw err;
  }
}

export function query(log, text, params = [], label = 'sql') {
  return run(pool, log, text, params, label);
}

/**
 * Run several statements on one connection inside a transaction.
 * Needed for `SET LOCAL hnsw.*` settings, which only last for the transaction.
 */
export async function withTransaction(log, fn) {
  const client = await pool.connect();
  const q = (text, params = [], label = 'sql', opts) => run(client, log, text, params, label, opts);
  try {
    await q('BEGIN', [], 'begin');
    const result = await fn(q);
    await q('COMMIT', [], 'commit');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
