/**
 * RAG generation: put the re-ranked items into the prompt as numbered CONTEXT and
 * let Llama write a conversational answer that cites them like [1], [2].
 * "Grounding" = the model is told to use only this context, which limits hallucination.
 */
import { preview } from '../logger.js';
import { chatStream } from '../llm/ollama.js';

const SYSTEM = `You are a friendly search assistant for a catalog.
Answer using ONLY the items in CONTEXT. Cite items by number like [1] or [2].
If nothing in CONTEXT fits, say so honestly and suggest how the user could refine the search.
Keep it concise: a short intro sentence, then the best matches with one line on why each fits.`;

export function formatContext(items) {
  return items
    .map((it, i) => {
      const meta = [
        it.year && `year ${it.year}`,
        it.genres?.length && it.genres.join('/'),
        it.price != null && `$${it.price}`,
        it.rating != null && `rating ${it.rating}`,
      ]
        .filter(Boolean)
        .join(' | ');
      return `[${i + 1}] ${it.title} — ${meta}\n    ${it.body}`;
    })
    .join('\n');
}

export function buildMessages(queryText, items, history = []) {
  const context = items.length ? formatContext(items) : '(no matching items)';
  return [
    { role: 'system', content: SYSTEM },
    ...history.slice(-6), // short memory for follow-up questions
    { role: 'user', content: `CONTEXT:\n${context}\n\nUSER QUERY: ${queryText}` },
  ];
}

export async function* streamAnswer(log, queryText, items, { history = [], signal } = {}) {
  const messages = buildMessages(queryText, items, history);
  const chars = messages.reduce((a, m) => a + m.content.length, 0);
  log.info(
    { contextItems: items.length, historyTurns: history.length, promptChars: chars, approxPromptTokens: Math.round(chars / 4) },
    'answer prompt built',
  );
  log.trace({ context: preview(messages.at(-1).content, 2000) }, 'answer context');
  yield* chatStream(log, messages, { signal, label: 'llm:answer' });
}
