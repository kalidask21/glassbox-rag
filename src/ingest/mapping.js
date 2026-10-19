/**
 * THE ONE PLACE TO ADAPT TO YOUR OWN JSON.
 *
 * Turns any raw record into the row shape the `items` table expects:
 *   metadata columns (exact filters) + `body` (the text that gets embedded).
 *
 * It already understands both data/movies.json and data/products.sample.json.
 * For your own data, edit the field fallbacks below or write a new toItem().
 *
 * Tip: what you put in `body` is what "meaning" search can find. Put the
 * descriptive words there; keep exact facts (price, year) in columns.
 */

const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
const toNum = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function toItem(record) {
  const externalId = first(record.id, record.styleCode, record.sku, record.external_id);
  const title = first(record.title, record.name);
  if (!externalId) return { skip: 'missing id (id | styleCode | sku)' };
  if (!title) return { skip: 'missing title (title | name)' };

  const genres = [...(record.genres ?? []), ...(record.tags ?? [])]
    .map((g) => String(g).trim().toLowerCase())
    .filter(Boolean);
  const description = first(record.overview, record.description, record.summary, '');

  // Natural-language text for the embedding model. Labels help the model.
  const bodyParts = [
    description,
    genres.length && `Genres/tags: ${genres.join(', ')}.`,
    record.director && `Directed by ${record.director}.`,
    record.category && `Category: ${record.category}.`,
    record.color && `Color: ${record.color}.`,
  ].filter(Boolean);
  const body = bodyParts.join(' ');
  if (!body.trim()) return { skip: 'no descriptive text to embed' };

  return {
    item: {
      externalId: String(externalId),
      title: String(title),
      category: first(record.category, record.type, 'movie'),
      genres,
      year: toNum(first(record.year, record.release_year)),
      price: toNum(record.price),
      rating: toNum(record.rating),
      doc: record,
      body,
    },
  };
}
