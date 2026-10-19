/**
 * Deterministic query parsing with regexes. Pure function (no I/O) so it's easy to test.
 * Runs before the LLM analyzer; its filters win on conflict because they're exact.
 *
 *   "comedy from the 90s rated over 8"  -> { year_min:1990, year_max:1999, rating_min:8 }
 *   "running shoes under $120"          -> { price_max:120 }
 */
export function ruleBasedParse(query) {
  const filters = {};
  const matched = [];
  let m;

  if ((m = query.match(/\b(?:under|below|less than|cheaper than|max)\s*\$?\s*(\d+(?:\.\d+)?)/i))) {
    filters.price_max = Number(m[1]);
    matched.push(m[0]);
  }
  if ((m = query.match(/\b(?:over|above|more than|at least)\s*\$\s*(\d+(?:\.\d+)?)/i))) {
    filters.price_min = Number(m[1]);
    matched.push(m[0]);
  }
  if ((m = query.match(/\b(?:after|since|newer than)\s+((?:19|20)\d{2})\b/i))) {
    filters.year_min = Number(m[1]) + (/after|newer/i.test(m[0]) ? 1 : 0);
    matched.push(m[0]);
  }
  if ((m = query.match(/\b(?:before|older than)\s+((?:19|20)\d{2})\b/i))) {
    filters.year_max = Number(m[1]) - 1;
    matched.push(m[0]);
  }
  if ((m = query.match(/\b(?:from\s+)?(?:the\s+)?((?:19|20)\d0|\d0)'?s\b/i))) {
    let decade = Number(m[1]);
    if (decade < 100) decade += decade >= 30 ? 1900 : 2000;
    filters.year_min = decade;
    filters.year_max = decade + 9;
    matched.push(m[0]);
  }
  if ((m = query.match(/\b(?:in|from)\s+((?:19|20)\d{2})\b/i)) && filters.year_min === undefined) {
    filters.year_min = filters.year_max = Number(m[1]);
    matched.push(m[0]);
  }
  if ((m = query.match(/\b(?:rated|rating)\s*(?:above|over|at least|>=?)?\s*(\d(?:\.\d)?)\b/i))) {
    filters.rating_min = Number(m[1]);
    matched.push(m[0]);
  }

  let rest = query;
  for (const s of matched) rest = rest.replace(s, ' ');
  const semantic = rest.replace(/\s+/g, ' ').trim();

  return { filters, matched, semantic: semantic || query };
}
