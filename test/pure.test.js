// Unit tests for the pure parts of the pipeline (no DB or Ollama needed): npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleBasedParse } from '../src/search/rules.js';
import { buildFilterSql } from '../src/search/filters.js';
import { rrfFuse } from '../src/search/fusion.js';
import { toItem } from '../src/ingest/mapping.js';

test('rules: decade + rating', () => {
  const r = ruleBasedParse('funny movies from the 90s rated over 8');
  assert.equal(r.filters.year_min, 1990);
  assert.equal(r.filters.year_max, 1999);
  assert.equal(r.filters.rating_min, 8);
  assert.equal(r.semantic, 'funny movies');
});

test('rules: price', () => {
  const r = ruleBasedParse('black running shoes under $120');
  assert.equal(r.filters.price_max, 120);
  assert.equal(r.semantic, 'black running shoes');
});

test('rules: after/before years are exclusive', () => {
  assert.equal(ruleBasedParse('sci-fi after 2010').filters.year_min, 2011);
  assert.equal(ruleBasedParse('comedy before 2000').filters.year_max, 1999);
});

test('filters: parameterized SQL starting at given index', () => {
  const f = buildFilterSql({ genres: ['Comedy'], year_min: 1990, price_max: 100 }, 2);
  assert.equal(f.where, 'genres && $2::text[] AND year >= $3 AND price <= $4');
  assert.deepEqual(f.params, [['comedy'], 1990, 100]);
  assert.equal(f.nextIndex, 5);
});

test('filters: empty -> TRUE', () => {
  assert.equal(buildFilterSql({}).where, 'TRUE');
});

test('rrf: item in both lists beats item ranked #1 in only one', () => {
  const fused = rrfFuse([
    { name: 'vector', items: [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }] },
    { name: 'keyword', items: [{ id: 'b', score: 2.1 }, { id: 'c', score: 1.0 }] },
  ]);
  assert.equal(fused[0].id, 'b');
  assert.deepEqual(fused[0].sources, { vector: { rank: 2, score: 0.8 }, keyword: { rank: 1, score: 2.1 } });
});

test('mapping: movie and product records', () => {
  const m = toItem({ id: 'x', title: 'T', year: 2000, genres: ['Drama'], overview: 'A story.' }).item;
  assert.deepEqual(m.genres, ['drama']);
  assert.match(m.body, /A story\./);
  const p = toItem({ styleCode: 'S1', name: 'Shoe', price: '99', tags: ['Trail'], description: 'Grippy.' }).item;
  assert.equal(p.price, 99);
  assert.equal(p.externalId, 'S1');
  assert.ok(toItem({ title: 'no id' }).skip);
});

// ---------- Elasticsearch query builders ----------
import { buildElasticFilter, facetsBody, indexDefinition, keywordBody, knnBody } from '../src/search/elasticQuery.js';

test('elastic filter: same filters as Postgres, Elastic syntax', () => {
  assert.deepEqual(buildElasticFilter({ genres: ['Comedy'], year_min: 1990, year_max: 1999, price_max: 120, rating_min: 8 }), [
    { terms: { genres: ['comedy'] } },
    { range: { year: { gte: 1990, lte: 1999 } } },
    { range: { price: { lte: 120 } } },
    { range: { rating: { gte: 8 } } },
  ]);
  assert.deepEqual(buildElasticFilter({}), []);
});

test('elastic knn: filter goes inside knn (pre-filter) and num_candidates >= k', () => {
  const b = knnBody([0.1, 0.2], { year_min: 2010 }, 50, 20);
  assert.equal(b.knn.k, 50);
  assert.equal(b.knn.num_candidates, 50);
  assert.deepEqual(b.knn.filter, { bool: { filter: [{ range: { year: { gte: 2010 } } }] } });
  assert.deepEqual(b._source, { excludes: ['embedding'] });
  assert.equal(knnBody([0.1], {}, 5, 100).knn.filter, undefined);
});

test('elastic keyword: fuzzy multi_match with filters', () => {
  const b = keywordBody('intersteller', { genres: ['drama'] }, 10);
  assert.equal(b.query.bool.must.multi_match.fuzziness, 'AUTO');
  assert.deepEqual(b.query.bool.must.multi_match.fields, ['title^3', 'body']);
  assert.deepEqual(b.query.bool.filter, [{ terms: { genres: ['drama'] } }]);
});

test('elastic mapping + facets', () => {
  const m = indexDefinition(768).mappings.properties;
  assert.equal(m.embedding.dims, 768);
  assert.equal(m.embedding.similarity, 'cosine');
  assert.equal(m.genres.type, 'keyword');
  assert.equal(facetsBody({}).size, 0);
  assert.ok(facetsBody({}).aggs.genres.terms);
});
