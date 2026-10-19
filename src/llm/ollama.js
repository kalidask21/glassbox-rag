/**
 * Thin Ollama client using plain fetch so you can see every request in the logs.
 *  - embed():      text -> vectors              (POST /api/embed)
 *  - chatJson():   messages -> parsed JSON       (POST /api/chat, format = JSON schema)
 *  - chatStream(): messages -> async token stream (POST /api/chat, stream = true)
 */
import { config } from '../config.js';
import { preview, startTimer, vecPreview } from '../logger.js';

async function post(log, path, body, { signal } = {}) {
  let res;
  try {
    res = await fetch(`${config.ollamaUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    log.error({ err, url: config.ollamaUrl + path }, 'Ollama unreachable — is `ollama serve` running?');
    throw err;
  }
  if (!res.ok) {
    const text = await res.text();
    const hint = /not found/i.test(text) ? ` — run: ollama pull ${body.model}` : '';
    log.error({ status: res.status, body: preview(text, 400), model: body.model }, `Ollama error${hint}`);
    throw new Error(`Ollama ${path} ${res.status}: ${text}${hint}`);
  }
  return res;
}

export async function embed(log, texts, { kind = 'document' } = {}) {
  const prefix = kind === 'query' ? config.embedQueryPrefix : config.embedDocPrefix;
  const input = texts.map((t) => prefix + t);
  const t = startTimer(log, `embed:${kind}`, { count: texts.length, model: config.embedModel });
  log.trace({ firstInput: preview(input[0], 300) }, 'embedding input');

  const res = await post(log, '/api/embed', { model: config.embedModel, input });
  const data = await res.json();
  const vecs = data.embeddings;

  if (!vecs?.length || vecs.length !== texts.length) {
    throw new Error(`Expected ${texts.length} embeddings, got ${vecs?.length ?? 0}`);
  }
  if (vecs[0].length !== config.embedDim) {
    const msg = `Embedding dimension mismatch: ${config.embedModel} returned ${vecs[0].length}, but EMBED_DIM=${config.embedDim}. Update EMBED_DIM and vector(N) in sql/schema.sql, then re-run db:init + ingest.`;
    log.error({ got: vecs[0].length, expected: config.embedDim }, msg);
    throw new Error(msg);
  }
  t.end({ dim: vecs[0].length, ...(config.log.vectors ? { sample: vecPreview(vecs[0]) } : {}) });
  return vecs;
}

export async function chatJson(log, messages, schema, label = 'llm:json') {
  const t = startTimer(log, label, { model: config.chatModel });
  if (config.log.prompts) log.debug({ label, messages }, 'LLM prompt');

  const res = await post(log, '/api/chat', {
    model: config.chatModel,
    messages,
    format: schema,
    stream: false,
    options: { temperature: 0 },
  });
  const data = await res.json();
  const raw = data.message?.content ?? '';
  if (config.log.prompts) log.debug({ label, raw }, 'LLM raw output');

  try {
    const parsed = JSON.parse(raw);
    t.end({ evalTokens: data.eval_count, loadMs: Math.round((data.load_duration ?? 0) / 1e6) });
    if ((data.load_duration ?? 0) > 1e9) log.warn({ label }, 'model was loaded from disk (cold start); next calls will be faster');
    return parsed;
  } catch (err) {
    t.fail(err, { raw: preview(raw, 400) });
    throw new Error(`${label}: LLM returned invalid JSON`);
  }
}

/** Yields text chunks as the model generates them. Logs tokens/sec at the end. */
export async function* chatStream(log, messages, { signal, label = 'llm:stream' } = {}) {
  const t = startTimer(log, label, { model: config.chatModel });
  if (config.log.prompts) log.debug({ label, messages }, 'LLM prompt');

  const res = await post(log, '/api/chat', { model: config.chatModel, messages, stream: true }, { signal });
  const decoder = new TextDecoder();
  let buffer = '';
  let firstTokenMs = null;
  let full = '';
  const started = performance.now();

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const piece = msg.message?.content ?? '';
      if (piece) {
        if (firstTokenMs === null) {
          firstTokenMs = +(performance.now() - started).toFixed(1);
          log.debug({ firstTokenMs }, 'first token received (time-to-first-token)');
        }
        full += piece;
        yield piece;
      }
      if (msg.done) {
        const tokPerSec = msg.eval_duration ? +(msg.eval_count / (msg.eval_duration / 1e9)).toFixed(1) : null;
        t.end({ outputTokens: msg.eval_count, promptTokens: msg.prompt_eval_count, firstTokenMs, tokPerSec });
        if (config.log.prompts) log.debug({ label, answer: full }, 'LLM full answer');
      }
    }
  }
}

/** Used by /health and doctor. */
export async function listModels(log) {
  const res = await fetch(`${config.ollamaUrl}/api/tags`);
  if (!res.ok) throw new Error(`Ollama /api/tags ${res.status}`);
  const data = await res.json();
  const names = (data.models ?? []).map((m) => m.name);
  log.debug({ models: names }, 'ollama models installed');
  return names;
}
