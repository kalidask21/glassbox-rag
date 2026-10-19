/**
 * Minimal Elasticsearch client over fetch, so every request/response shows up in the logs
 * the same way SQL does. LOG_ELASTIC=true logs request bodies (vectors summarized).
 */
import { config } from './config.js';

const summarize = (value) =>
  JSON.parse(
    JSON.stringify(value ?? null, (key, v) =>
      Array.isArray(v) && v.length > 50 && typeof v[0] === 'number' ? `<vector dim=${v.length}>` : v,
    ),
  );

export async function esRequest(log, method, path, body, { label = `${method} ${path}`, ndjson = false, allow404 = false } = {}) {
  const url = `${config.elastic.url}${path}`;
  if (config.log.elastic) log.debug({ label, method, path, body: ndjson ? `<ndjson ${body.split('\n').length - 1} lines>` : summarize(body) }, `ES → ${label}`);

  const start = performance.now();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json' },
      body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
    });
  } catch (err) {
    log.error({ err, url }, 'Elasticsearch unreachable — `docker compose --profile elastic up -d`');
    throw err;
  }
  const ms = +(performance.now() - start).toFixed(1);
  const data = await res.json().catch(() => ({}));

  if (res.status === 404 && allow404) {
    log.debug({ label, ms }, `ES ← ${label}: 404`);
    return null;
  }
  if (!res.ok) {
    const reason = data?.error?.root_cause?.[0]?.reason ?? data?.error?.reason ?? JSON.stringify(data).slice(0, 300);
    log.error({ label, status: res.status, reason, body: summarize(body) }, `ES failed: ${label}`);
    throw new Error(`Elasticsearch ${label} ${res.status}: ${reason}`);
  }
  // `took` = time Elastic spent internally; ms = including network + JSON
  log.debug({ label, ms, took: data.took, hits: data.hits?.total?.value }, `ES ← ${label}`);
  return data;
}
