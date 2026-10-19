/**
 * Reciprocal Rank Fusion (Cormack et al., 2009). Pure function.
 *
 * Each retriever gives a ranked list. An item's fused score is
 *     sum over lists of 1 / (k + rank)
 * Only RANK matters, not raw score, so it can merge cosine similarity and
 * ts_rank (which live on totally different scales) without normalization.
 * k (default 60) dampens the advantage of being #1 vs #2.
 */
export function rrfFuse(lists, k = 60) {
  const byId = new Map();
  for (const { name, items } of lists) {
    items.forEach((item, idx) => {
      const rank = idx + 1;
      const { score, ...rest } = item;
      const entry = byId.get(item.id) ?? { ...rest, rrf: 0, sources: {} };
      entry.rrf += 1 / (k + rank);
      entry.sources[name] = { rank, score };
      byId.set(item.id, entry);
    });
  }
  return [...byId.values()]
    .map((e) => ({ ...e, rrf: +e.rrf.toFixed(6) }))
    .sort((a, b) => b.rrf - a.rrf);
}
