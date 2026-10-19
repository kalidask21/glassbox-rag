/**
 * Re-ranking: score each (query, document) PAIR together, which is more precise
 * than comparing two separately-computed embeddings — but slower, so only the
 * fused shortlist is re-ranked.
 *
 * Modes (RERANK_MODE):
 *  - cross-encoder: POST to the Python service in /reranker (bge-reranker-base)
 *  - llm:           ask Llama to score 0-10 (works with nothing extra installed; slower)
 *  - none:          keep RRF order
 *  - auto:          cross-encoder if RERANKER_URL is set, else none
 */
import { config } from '../config.js';
import { chatJson } from '../llm/ollama.js';

const docText = (it) => `${it.title}${it.year ? ` (${it.year})` : ''}. ${it.body}`.slice(0, 700);

function resolveMode() {
  if (config.rerankMode === 'auto') return config.rerankerUrl ? 'cross-encoder' : 'none';
  return config.rerankMode;
}

async function crossEncoderScores(log, queryText, items) {
  const res = await fetch(`${config.rerankerUrl}/rerank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: queryText, documents: items.map(docText) }),
  });
  if (!res.ok) throw new Error(`reranker ${res.status}: ${await res.text()}`);
  const data = await res.json();
  log.debug({ model: data.model, serverMs: data.ms }, 'cross-encoder responded');
  return data.scores;
}

async function llmScores(log, queryText, items) {
  const docs = items.map((it, i) => `[${i}] ${docText(it)}`).join('\n');
  const out = await chatJson(
    log,
    [
      {
        role: 'system',
        content: 'Rate how well each document matches the query, 0 (irrelevant) to 10 (perfect). Return a score for every index.',
      },
      { role: 'user', content: `Query: ${queryText}\n\nDocuments:\n${docs}` },
    ],
    {
      type: 'object',
      properties: {
        scores: {
          type: 'array',
          items: { type: 'object', properties: { index: { type: 'integer' }, score: { type: 'number' } }, required: ['index', 'score'] },
        },
      },
      required: ['scores'],
    },
    'llm:rerank',
  );
  const scores = new Array(items.length).fill(0);
  for (const { index, score } of out.scores ?? []) if (index >= 0 && index < items.length) scores[index] = score;
  const missing = items.length - (out.scores?.length ?? 0);
  if (missing > 0) log.warn({ missing }, 'LLM reranker skipped some documents (scored 0)');
  return scores;
}

export async function rerank(log, queryText, items, finalK, trace) {
  const mode = resolveMode();
  const s = trace.stage('rerank', { mode, candidates: items.length });

  if (mode === 'none' || items.length === 0) {
    s.end({ mode: 'none', kept: Math.min(finalK, items.length) });
    return items.slice(0, finalK).map((it, i) => ({ ...it, rerankScore: null, rankBefore: i + 1 }));
  }

  try {
    const scores = mode === 'cross-encoder' ? await crossEncoderScores(log, queryText, items) : await llmScores(log, queryText, items);
    const ranked = items
      .map((it, i) => ({ ...it, rerankScore: +Number(scores[i]).toFixed(4), rankBefore: i + 1 }))
      .sort((a, b) => b.rerankScore - a.rerankScore);

    // The most useful debugging view: how much did re-ranking change the order?
    const movement = ranked.slice(0, finalK).map((it, i) => ({
      title: it.title,
      before: it.rankBefore,
      after: i + 1,
      move: it.rankBefore - (i + 1),
      score: it.rerankScore,
    }));
    log.debug({ movement }, 'rerank movement (move > 0 = promoted)');
    s.end({ mode, kept: Math.min(finalK, ranked.length), topScore: ranked[0]?.rerankScore ?? null });
    return ranked.slice(0, finalK);
  } catch (err) {
    log.warn({ err: err.message, mode }, 'rerank failed — keeping RRF order');
    s.end({ mode: `${mode}-failed` });
    return items.slice(0, finalK).map((it, i) => ({ ...it, rerankScore: null, rankBefore: i + 1 }));
  }
}
