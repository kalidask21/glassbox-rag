/** Checks every dependency and returns actionable hints. Used by GET /health and `npm run doctor`. */
import { config } from './config.js';
import { query } from './db.js';
import { listModels } from './llm/ollama.js';
import { esRequest } from './elastic.js';

export async function checkHealth(log) {
  const out = { db: {}, ollama: {}, reranker: {}, elastic: {} };

  try {
    const ext = await query(log, "SELECT extversion FROM pg_extension WHERE extname = 'vector'", [], 'health:pgvector');
    const pgvector = ext.rows[0]?.extversion ?? null;
    const counts = await query(
      log,
      'SELECT count(*)::int AS items, count(embedding)::int AS embedded FROM items',
      [],
      'health:counts',
    ).catch(() => null);
    out.db = {
      ok: Boolean(pgvector && counts),
      pgvector,
      items: counts?.rows[0].items ?? null,
      embedded: counts?.rows[0].embedded ?? null,
    };
    if (!pgvector) out.db.hint = 'pgvector extension missing — run `npm run db:init`';
    else if (!counts) out.db.hint = 'items table missing — run `npm run db:init`';
    else if (counts.rows[0].items === 0) out.db.hint = 'table is empty — run `npm run ingest`';
  } catch (err) {
    out.db = { ok: false, error: err.message, hint: 'Is Postgres running? `docker compose up -d` and check DATABASE_URL' };
  }

  try {
    const models = await listModels(log);
    const has = (m) => models.some((n) => n === m || n.startsWith(`${m}:`));
    out.ollama = {
      ok: has(config.embedModel) && has(config.chatModel),
      embedModel: { name: config.embedModel, installed: has(config.embedModel) },
      chatModel: { name: config.chatModel, installed: has(config.chatModel) },
    };
    const missing = [config.embedModel, config.chatModel].filter((m) => !has(m));
    if (missing.length) out.ollama.hint = missing.map((m) => `ollama pull ${m}`).join(' && ');
  } catch (err) {
    out.ollama = { ok: false, error: err.message, hint: 'Start Ollama: `ollama serve` (or open the Ollama app)' };
  }

  if (config.rerankerUrl) {
    try {
      const res = await fetch(`${config.rerankerUrl}/health`);
      out.reranker = { ok: res.ok, ...(await res.json()) };
    } catch (err) {
      out.reranker = { ok: false, error: err.message, hint: '`docker compose --profile rerank up -d` or unset RERANKER_URL' };
    }
  } else {
    out.reranker = { ok: true, mode: config.rerankMode, note: 'RERANKER_URL not set (cross-encoder disabled)' };
  }

  // Elastic is only REQUIRED when it's the active backend; otherwise it's informational.
  const required = config.searchBackend === 'elastic';
  try {
    const health = await esRequest(log, 'GET', '/_cluster/health', undefined, { label: 'health:es' });
    const count = await esRequest(log, 'GET', `/${config.elastic.index}/_count`, undefined, { label: 'health:es count', allow404: true });
    out.elastic = { ok: Boolean(count), required, status: health.status, index: config.elastic.index, docs: count?.count ?? null };
    if (!count) out.elastic.hint = 'index missing — run `npm run sync:elastic`';
    else if (count.count === 0) out.elastic.hint = 'index empty — run `npm run sync:elastic`';
  } catch (err) {
    out.elastic = { ok: false, required, error: err.message, hint: '`docker compose --profile elastic up -d`, then `npm run sync:elastic`' };
  }

  out.ok = out.db.ok && out.ollama.ok && out.reranker.ok && (out.elastic.ok || !required);
  return out;
}
