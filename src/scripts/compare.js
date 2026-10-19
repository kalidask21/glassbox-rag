/**
 * Run ONE query through Postgres and Elasticsearch side by side.
 * The LLM analyzer and the query embedding run once and are shared, so the only
 * difference you see is the retrieval backend.
 *
 *   npm run compare -- "funny space movie from the 2010s"
 *   npm run compare -- "intersteller"            # typo: watch Elastic's fuzzy match
 *   RERANK_MODE=none npm run compare -- "heist"  # compare raw retrieval only
 */
import { flushLogs, logger } from '../logger.js';
import { pool } from '../db.js';
import { runSearch } from '../search/pipeline.js';
import { facets } from '../search/retrieveElastic.js';

const q = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim();
if (!q) {
  console.error('Usage: npm run compare -- "your query"');
  process.exit(1);
}
const log = logger.child({ reqId: 'compare' });

const stageMs = (out, name) => out.trace.stages.find((s) => s.stage === name)?.ms ?? '-';
const counts = (out) => {
  const st = out.trace.stages.find((s) => s.stage === 'retrieve') ?? {};
  return `vector ${st.vector ?? '-'} / keyword ${st.keyword ?? '-'}`;
};

try {
  const pg = await runSearch(log, q, { backend: 'postgres' });
  let es;
  let esError = null;
  try {
    es = await runSearch(log, q, { backend: 'elastic', analysis: pg.analysis, queryVec: pg.queryVec });
  } catch (err) {
    esError = err.message;
  }
  await flushLogs();

  console.log('\n── shared analysis ────────────────────');
  console.log(JSON.stringify({ semantic_query: pg.analysis.semantic_query, keywords: pg.analysis.keywords, filters: pg.analysis.filters }));

  if (esError) {
    console.log(`\n❌ Elastic failed: ${esError}`);
    console.log('   Start it: docker compose --profile elastic up -d && npm run sync:elastic\n');
  } else {
    const n = Math.max(pg.results.length, es.results.length);
    console.log('\n── results ────────────────────────────');
    console.table(
      Array.from({ length: n }, (_, i) => ({
        '#': i + 1,
        postgres: pg.results[i]?.title ?? '',
        elastic: es.results[i]?.title ?? '',
        same: pg.results[i] && pg.results[i].id === es.results[i]?.id ? '✓' : '',
      })),
    );
    const pgIds = new Set(pg.results.map((r) => r.id));
    const overlap = es.results.filter((r) => pgIds.has(r.id)).length;
    console.log(`overlap: ${overlap}/${n} items appear in both lists`);

    console.log('\n── retrieval ──────────────────────────');
    console.table([
      { backend: 'postgres', candidates: counts(pg), retrieveMs: stageMs(pg, 'retrieve') },
      { backend: 'elastic', candidates: counts(es), retrieveMs: stageMs(es, 'retrieve') },
    ]);

    const f = await facets(log, pg.analysis.filters);
    await flushLogs();
    console.log('\n── elastic facets (for a filter sidebar) ──');
    for (const [name, buckets] of Object.entries(f)) {
      console.log(`${name.padEnd(10)} ${buckets.map((b) => `${b.value} (${b.count})`).join(' · ') || '-'}`);
    }
    console.log('');
  }
} catch (err) {
  log.fatal({ err }, 'compare failed — run `npm run doctor`');
  process.exitCode = 1;
} finally {
  await pool.end();
  await flushLogs();
}
