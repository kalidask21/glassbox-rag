/**
 * HTTP API
 *   GET  /health          dependency checks with hints
 *   POST /search          { query, k?, debug? }            -> ranked JSON results
 *   POST /chat            { query, history?, debug? }      -> Server-Sent Events stream
 *
 * Every request gets an 8-char reqId (also returned as X-Request-Id). Grep it in logs/app.log
 * to see that request's full journey.
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { config } from './config.js';
import { flushLogs, logger } from './logger.js';
import { pool } from './db.js';
import { checkHealth } from './health.js';
import { runSearch } from './search/pipeline.js';
import { streamAnswer } from './search/answer.js';
import { BACKEND_NAMES } from './search/backends.js';

const app = Fastify({
  loggerInstance: logger,
  genReqId: () => randomUUID().slice(0, 8),
  requestIdLogLabel: 'reqId',
});

app.addHook('onRequest', async (req, reply) => {
  reply.header('X-Request-Id', req.id);
});

app.setErrorHandler((err, req, reply) => {
  req.log.error({ err }, 'request failed');
  const status = err.statusCode ?? 500;
  reply.status(status).send({ error: err.message, reqId: req.id });
});

const searchBody = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 500 },
    k: { type: 'integer', minimum: 1, maximum: 50 },
    debug: { type: 'boolean' },
    backend: { enum: BACKEND_NAMES },
  },
};

app.get('/health', async (req, reply) => {
  const health = await checkHealth(req.log);
  if (!health.ok) req.log.warn({ health }, 'health check: something is not ready');
  reply.status(health.ok ? 200 : 503).send(health);
});

app.post('/search', { schema: { body: searchBody } }, async (req) => {
  const { query, k, debug = false, backend } = req.body;
  const out = await runSearch(req.log, query, { finalK: k, backend });
  return {
    reqId: req.id,
    query,
    backend: out.backend,
    results: out.results,
    ...(debug && { analysis: out.analysis, trace: out.trace }),
  };
});

app.post(
  '/chat',
  {
    schema: {
      body: {
        ...searchBody,
        properties: {
          ...searchBody.properties,
          history: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              required: ['role', 'content'],
              properties: { role: { enum: ['user', 'assistant'] }, content: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { query, history = [], debug = false, k, backend } = req.body;
    const log = req.log;

    reply.hijack(); // we write the raw SSE stream ourselves
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Request-Id': req.id,
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // Stop generating if the client goes away (saves GPU/CPU).
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) {
        log.warn('client disconnected mid-stream — aborting LLM generation');
        abort.abort();
      }
    });

    try {
      const out = await runSearch(log, query, { finalK: k, backend });
      send('results', { reqId: req.id, backend: out.backend, results: out.results, ...(debug && { analysis: out.analysis, trace: out.trace }) });

      const started = performance.now();
      let chars = 0;
      for await (const token of streamAnswer(log, query, out.raw, { history, signal: abort.signal })) {
        chars += token.length;
        send('token', { t: token });
      }
      send('done', { reqId: req.id, answerChars: chars, answerMs: Math.round(performance.now() - started), totalMs: out.trace.totalMs + Math.round(performance.now() - started) });
      log.info({ answerChars: chars }, '💬 chat done');
    } catch (err) {
      if (abort.signal.aborted) return;
      log.error({ err }, 'chat failed');
      send('error', { error: err.message, reqId: req.id });
    } finally {
      res.end();
    }
  },
);

async function start() {
  logger.info(
    {
      port: config.port,
      backend: config.searchBackend,
      embedModel: config.embedModel,
      chatModel: config.chatModel,
      analyzer: config.analyzerMode,
      rerank: config.rerankMode,
      reranker: config.rerankerUrl || null,
      logLevel: config.log.level,
      logFile: config.log.file || null,
      flags: { sql: config.log.sql, prompts: config.log.prompts, vectors: config.log.vectors, explain: config.log.explain },
    },
    'starting server',
  );
  const health = await checkHealth(logger.child({ reqId: 'startup' }));
  if (!health.ok) logger.warn({ health }, '⚠ some dependencies are not ready — see hints (server starts anyway)');
  else logger.info({ items: health.db.items }, '✅ all dependencies ready');

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

const shutdown = async (signal) => {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  await flushLogs();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));

start().catch(async (err) => {
  logger.fatal({ err }, 'failed to start');
  await flushLogs();
  process.exit(1);
});
