/**
 * Pure builders for Elasticsearch requests (no I/O, unit-tested).
 * They mirror the Postgres side: same filters, same two retrievers.
 */

/** Index settings + mappings. The Elastic equivalent of sql/schema.sql. */
export function indexDefinition(dims) {
  return {
    settings: {
      number_of_shards: 1,
      number_of_replicas: 0, // single local node
      analysis: {
        normalizer: { lc: { type: 'custom', filter: ['lowercase'] } },
      },
    },
    mappings: {
      dynamic: 'strict', // reject fields we didn't declare (catches mapping bugs early)
      properties: {
        external_id: { type: 'keyword' },
        // text = analyzed for full-text (stemmed, english); .raw = exact value for sorting/aggs
        title: { type: 'text', analyzer: 'english', fields: { raw: { type: 'keyword' } } },
        body: { type: 'text', analyzer: 'english' },
        category: { type: 'keyword', normalizer: 'lc' },
        genres: { type: 'keyword', normalizer: 'lc' },
        year: { type: 'integer' },
        price: { type: 'float' },
        rating: { type: 'float' },
        embedding: {
          type: 'dense_vector',
          dims,
          index: true,
          similarity: 'cosine',
          // Plain float HNSW to match pgvector exactly. Newer Elastic defaults to a quantized
          // variant (int8_hnsw / bbq) that uses far less memory — worth trying at scale.
          index_options: { type: 'hnsw', m: 16, ef_construction: 64 },
        },
      },
    },
  };
}

/** Same filter object as filters.js, translated to Elastic filter clauses. */
export function buildElasticFilter(filters = {}) {
  const clauses = [];
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const range = (field, gte, lte) => {
    const r = {};
    if (isNum(gte)) r.gte = gte;
    if (isNum(lte)) r.lte = lte;
    if (Object.keys(r).length) clauses.push({ range: { [field]: r } });
  };

  if (Array.isArray(filters.genres) && filters.genres.length) {
    clauses.push({ terms: { genres: filters.genres.map((g) => String(g).toLowerCase()) } }); // ANY of
  }
  if (filters.category) clauses.push({ term: { category: String(filters.category).toLowerCase() } });
  range('year', filters.year_min, filters.year_max);
  range('price', filters.price_min, filters.price_max);
  range('rating', filters.rating_min, undefined);
  return clauses;
}

const SOURCE = { excludes: ['embedding'] }; // never ship 768 floats back per hit

/**
 * kNN search. Key difference from pgvector: the filter is applied DURING the HNSW walk
 * (pre-filtering), so you still get k results even when filters are strict.
 */
export function knnBody(queryVec, filters, k, numCandidates) {
  const filter = buildElasticFilter(filters);
  return {
    knn: {
      field: 'embedding',
      query_vector: queryVec,
      k,
      num_candidates: Math.max(numCandidates, k),
      ...(filter.length && { filter: { bool: { filter } } }),
    },
    size: k,
    _source: SOURCE,
  };
}

/**
 * BM25 keyword search with typo tolerance (fuzziness AUTO: 1 edit for 3-5 char words,
 * 2 edits for longer). Title matches count 3x.
 */
export function keywordBody(text, filters, k) {
  return {
    query: {
      bool: {
        must: {
          multi_match: {
            query: text,
            fields: ['title^3', 'body'],
            fuzziness: 'AUTO',
            prefix_length: 1, // first letter must match: faster, fewer silly matches
            operator: 'or',
          },
        },
        filter: buildElasticFilter(filters),
      },
    },
    size: k,
    _source: SOURCE,
  };
}

/** Facet counts for a results page ("Comedy (12) · 2010s (30) · $100–150 (8)"). */
export function facetsBody(filters) {
  return {
    size: 0,
    query: { bool: { filter: buildElasticFilter(filters) } },
    aggs: {
      genres: { terms: { field: 'genres', size: 15 } },
      categories: { terms: { field: 'category', size: 10 } },
      decades: { histogram: { field: 'year', interval: 10, min_doc_count: 1 } },
      price: { range: { field: 'price', ranges: [{ to: 100 }, { from: 100, to: 150 }, { from: 150 }] } },
    },
  };
}
