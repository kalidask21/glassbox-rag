/** `npm run db:init` — (re)creates the schema from sql/schema.sql. WARNING: drops the items table. */
import { readFile } from 'node:fs/promises';
import { flushLogs, logger } from '../logger.js';
import { pool } from '../db.js';

const log = logger.child({ reqId: 'db-init' });
try {
  const sql = await readFile(new URL('../../sql/schema.sql', import.meta.url), 'utf8');
  log.warn('dropping and recreating table `items`');
  await pool.query(sql); // multi-statement script, run as one simple query
  const { rows } = await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
  const idx = await pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'items'");
  log.info({ pgvector: rows[0]?.extversion, indexes: idx.rows.map((r) => r.indexname) }, 'schema ready');
} catch (err) {
  log.fatal({ err }, 'db:init failed — is Postgres running (`docker compose up -d`)?');
  process.exitCode = 1;
} finally {
  await pool.end();
  await flushLogs();
}
