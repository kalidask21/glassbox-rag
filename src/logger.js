/**
 * Logging setup.
 *
 * - One root pino logger. Every HTTP request / CLI run gets a child logger with a
 *   `reqId`, so you can grep one request's whole journey through the pipeline.
 * - `startTimer` logs "▶ stage start" (debug) and "✔ stage done" (info) with `ms`.
 * - `createTrace` does the same AND records each stage, so the API can return a
 *   timing breakdown when you pass `"debug": true`.
 */
import pino from 'pino';
import { config } from './config.js';

const targets = [];
if (config.log.pretty) {
  targets.push({
    target: 'pino-pretty',
    level: config.log.level,
    options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,app' },
  });
} else {
  targets.push({ target: 'pino/file', level: config.log.level, options: { destination: 1 } });
}
if (config.log.file) {
  targets.push({
    target: 'pino/file',
    level: config.log.level,
    options: { destination: config.log.file, mkdir: true },
  });
}

export const logger = pino(
  {
    level: config.log.level,
    base: { app: 'vector-search' },
    serializers: { err: pino.stdSerializers.err },
  },
  pino.transport({ targets }),
);

/** Shorten long text for log lines. */
export function preview(text, n = 160) {
  if (text == null) return text;
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s;
}

/** Summarize an embedding: dimension, first values and L2 norm (≈1.0 means normalized). */
export function vecPreview(v) {
  if (!v) return null;
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return { dim: v.length, head: v.slice(0, 5).map((x) => +x.toFixed(4)), norm: +norm.toFixed(4) };
}

export function startTimer(log, stage, extra = {}) {
  const start = process.hrtime.bigint();
  log.debug({ stage, ...extra }, `▶ ${stage}`);
  const elapsed = () => +(Number(process.hrtime.bigint() - start) / 1e6).toFixed(1);
  return {
    end(fields = {}, msg) {
      const ms = elapsed();
      log.info({ stage, ms, ...fields }, msg ?? `✔ ${stage}`);
      return ms;
    },
    fail(err, fields = {}) {
      const ms = elapsed();
      log.error({ stage, ms, err, ...fields }, `✖ ${stage} failed`);
      return ms;
    },
  };
}

const primitive = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Collects per-stage timings for a single request. */
export function createTrace(log) {
  const stages = [];
  const t0 = process.hrtime.bigint();
  return {
    stages,
    stage(name, extra = {}) {
      const t = startTimer(log, name, extra);
      return {
        end(fields = {}, msg) {
          const ms = t.end(fields, msg);
          const small = Object.fromEntries(Object.entries(fields).filter(([, v]) => primitive(v)));
          stages.push({ stage: name, ms, ...small });
          return ms;
        },
        fail(err, fields = {}) {
          const ms = t.fail(err, fields);
          stages.push({ stage: name, ms, error: err.message });
          return ms;
        },
      };
    },
    totalMs: () => +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1),
  };
}

/** Flush async log transport before the process exits (CLI scripts). */
export function flushLogs() {
  return new Promise((resolve) => {
    try {
      logger.flush(() => setTimeout(resolve, 100));
    } catch {
      setTimeout(resolve, 200);
    }
  });
}
