/**
 * Debug the whole pipeline from the terminal, no HTTP needed.
 *
 *   npm run ask -- "feel-good space movies"
 *   npm run ask -- "animated family films from the 2010s" --no-answer
 *   LOG_LEVEL=trace LOG_PROMPTS=true npm run ask -- "heist movie"
 */
import { flushLogs, logger } from '../logger.js';
import { pool } from '../db.js';
import { runSearch } from '../search/pipeline.js';
import { streamAnswer } from '../search/answer.js';

const args = process.argv.slice(2);
const noAnswer = args.includes('--no-answer');
const q = args.filter((a) => !a.startsWith('--')).join(' ').trim();

if (!q) {
  console.error('Usage: npm run ask -- "your query" [--no-answer]');
  process.exit(1);
}

const log = logger.child({ reqId: 'cli' });

try {
  const out = await runSearch(log, q);
  await flushLogs();

  console.log('\n── analysis ───────────────────────────');
  console.log(JSON.stringify(out.analysis, null, 2));

  console.log('\n── results ────────────────────────────');
  console.table(
    out.results.map((r, i) => ({
      '#': i + 1,
      title: r.title,
      year: r.year,
      rrf: r.scores.rrf,
      rerank: r.scores.rerank,
      vecRank: r.scores.sources?.vector?.rank ?? '-',
      kwRank: r.scores.sources?.keyword?.rank ?? '-',
    })),
  );

  console.log('\n── timings (ms) ───────────────────────');
  console.table(out.trace.stages.map(({ stage, ms }) => ({ stage, ms })));
  console.log(`total: ${out.trace.totalMs} ms`);

  if (!noAnswer) {
    console.log('\n── answer ─────────────────────────────');
    for await (const token of streamAnswer(log, q, out.raw)) process.stdout.write(token);
    process.stdout.write('\n');
  }
} catch (err) {
  log.fatal({ err }, 'ask failed — run `npm run doctor`');
  process.exitCode = 1;
} finally {
  await pool.end();
  await flushLogs();
}
