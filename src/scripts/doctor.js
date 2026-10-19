/** `npm run doctor` — checks Postgres, pgvector, Ollama models and the reranker, with fix hints. */
import { checkHealth } from '../health.js';
import { flushLogs, logger } from '../logger.js';
import { pool } from '../db.js';

const log = logger.child({ reqId: 'doctor' });
const health = await checkHealth(log);

const line = (name, part) => {
  const icon = part.ok ? '✅' : '❌';
  const { ok, hint, ...rest } = part;
  console.log(`${icon} ${name.padEnd(9)} ${JSON.stringify(rest)}`);
  if (hint) console.log(`   ↳ fix: ${hint}`);
};

await flushLogs();
console.log('\n── doctor ─────────────────────────────');
line('postgres', health.db);
line('ollama', health.ollama);
line('reranker', health.reranker);
if (health.elastic.ok || health.elastic.required) line('elastic', health.elastic);
else console.log(`➖ elastic   not running (optional while SEARCH_BACKEND=postgres)\n   ↳ to try it: ${health.elastic.hint}`);
console.log(health.ok ? '\nAll good. Next: npm run ask -- "your query"\n' : '\nFix the ❌ items above, then run doctor again.\n');

await pool.end();
process.exitCode = health.ok ? 0 : 1;
