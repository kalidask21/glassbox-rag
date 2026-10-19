/**
 * Metadata filters -> parameterized SQL WHERE clause. Pure function.
 * Values are always passed as $n params (never string-concatenated) to avoid SQL injection.
 */
export function buildFilterSql(filters = {}, startIndex = 1) {
  const clauses = [];
  const params = [];
  let i = startIndex;
  const add = (sql, value) => {
    clauses.push(sql.replace('?', `$${i++}`));
    params.push(value);
  };
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  if (Array.isArray(filters.genres) && filters.genres.length) {
    // && = array overlap: matches if the item has ANY of these genres
    add('genres && ?::text[]', filters.genres.map((g) => String(g).toLowerCase()));
  }
  if (filters.category) add('lower(category) = lower(?)', String(filters.category));
  if (isNum(filters.year_min)) add('year >= ?', filters.year_min);
  if (isNum(filters.year_max)) add('year <= ?', filters.year_max);
  if (isNum(filters.price_min)) add('price >= ?', filters.price_min);
  if (isNum(filters.price_max)) add('price <= ?', filters.price_max);
  if (isNum(filters.rating_min)) add('rating >= ?', filters.rating_min);

  return {
    where: clauses.length ? clauses.join(' AND ') : 'TRUE',
    params,
    nextIndex: i,
    applied: clauses.length,
  };
}
