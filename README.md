# glassbox-rag

A **glass-box RAG search engine** — a local, fully-logged **semantic + hybrid search engine with a conversational answer**. Nothing is a black box: every stage logs what it did, why, and how long it took, so you can read the whole pipeline in the logs while you learn. Built on:

- **Postgres + pgvector** — metadata and embeddings in one database
- **Ollama** — local embeddings (`nomic-embed-text`) and a local Llama (`llama3.1:8b`)
- **Node.js + Fastify** — the API
- **Optional Python cross-encoder** — precise re-ranking (`bge-reranker-base`)
- **Optional Elasticsearch** — a second retrieval backend you can switch to or compare side by side

It ships with a small movie dataset and a sample product dataset so you can see how the same code serves a "Nike-style" product search. Every stage logs what it did, why, and how long it took — the project is meant to be *read in the logs* while you learn.

---

## 1. How a query flows

```
 "funny space movies from the 2010s"
            │
            ▼
 ┌────────────────────┐   rules (regex): year 2010–2019
 │ 1. Query analyzer  │   LLM (Llama, JSON schema): genres=[comedy, science fiction],
 └────────────────────┘   semantic_query="funny space movies", keywords=["space"]
            │
            ▼
 ┌────────────────────┐
 │ 2. Embed query     │   "search_query: funny space movies" → 768 numbers
 └────────────────────┘
            │
     ┌──────┴───────┐      (both run in parallel, both apply the metadata filters)
     ▼              ▼
 ┌─────────┐   ┌──────────┐
 │ Vector  │   │ Keyword  │  vector: HNSW index, cosine distance  (meaning)
 │ search  │   │ search   │  keyword: tsvector + GIN, ts_rank_cd  (exact words)
 └─────────┘   └──────────┘
     └──────┬───────┘
            ▼
 ┌────────────────────┐
 │ 3. RRF fusion      │   score = Σ 1/(60 + rank)  — merges lists by rank, not raw score
 └────────────────────┘
            ▼
 ┌────────────────────┐
 │ 4. Re-rank         │   cross-encoder (or Llama) scores each (query, item) pair; keep top 8
 └────────────────────┘
            ▼
 ┌────────────────────┐
 │ 5. Answer (RAG)    │   Llama writes a reply using ONLY those 8 items, citing [1], [2]…
 └────────────────────┘   streamed to the client token by token (SSE)
```

| Stage | File |
|---|---|
| Config + env flags | `src/config.js` |
| Logging, timers, trace | `src/logger.js` |
| Postgres + SQL logging | `src/db.js` |
| Ollama client (embed / JSON / stream) | `src/llm/ollama.js` |
| JSON → table row mapping | `src/ingest/mapping.js` |
| Ingest script | `src/ingest/ingest.js` |
| Rule parser / SQL filters / RRF (pure, tested) | `src/search/rules.js`, `filters.js`, `fusion.js` |
| Query analyzer | `src/search/queryAnalyzer.js` |
| Vector + keyword retrieval (Postgres) | `src/search/retrieve.js` |
| Vector + keyword retrieval (Elastic) | `src/search/retrieveElastic.js`, `elasticQuery.js` (pure, tested), `src/elastic.js` |
| Backend switch | `src/search/backends.js` |
| Postgres → Elastic sync | `src/ingest/sync-elastic.js` |
| Side-by-side comparison | `src/scripts/compare.js` |
| Re-ranking | `src/search/rerank.js` |
| RAG prompt + streaming | `src/search/answer.js` |
| Orchestration | `src/search/pipeline.js` |
| HTTP API | `src/server.js` |

---

## 2. Quick start

**Prerequisites:** Node 20+, Docker, [Ollama](https://ollama.com).

```bash
# 1. Database (Postgres 17 + pgvector; schema is created automatically on first start)
docker compose up -d

# 2. Local models
ollama pull nomic-embed-text
ollama pull llama3.1:8b

# 3. App
npm install
cp .env.example .env

# 4. Check everything is wired up (prints a ✅/❌ list with fix hints)
npm run doctor

# 5. Load and embed the sample movies
npm run ingest

# 6. Ask something from the terminal — shows analysis, ranking table, timings, answer
npm run ask -- "feel-good animated movie for the whole family"

# 7. Run the API
npm run dev
```

### Calling the API

```bash
# Health (503 + hints if something is missing)
curl localhost:3000/health

# Search: ranked JSON. "debug": true adds the analysis and per-stage timings.
curl -X POST localhost:3000/search -H 'content-type: application/json' \
  -d '{"query":"tense heist movie from the 90s","k":5,"debug":true}'

# Chat: Server-Sent Events → event: results, many event: token, event: done
curl -N -X POST localhost:3000/chat -H 'content-type: application/json' \
  -d '{"query":"something like The Martian but funnier"}'

# Follow-up question with conversation history
curl -N -X POST localhost:3000/chat -H 'content-type: application/json' -d '{
  "query":"which of those is best for kids?",
  "history":[{"role":"user","content":"funny space movies"},
             {"role":"assistant","content":"[1] The Martian ... [2] Toy Story ..."}]
}'
```

Every response carries an `X-Request-Id` header. `grep <id> logs/app.log` shows that request's full journey.

### Optional: cross-encoder re-ranker

```bash
docker compose --profile rerank up -d      # first start downloads the model (~1 GB)
# then in .env:
RERANKER_URL=http://localhost:8000
```

Without it, set `RERANK_MODE=llm` to have Llama score candidates (slower, nothing extra to install), or leave `auto` to skip re-ranking.

### Optional: Elasticsearch backend

```bash
docker compose --profile elastic up -d     # Elasticsearch 8 on :9200 (give it ~30s)
npm run sync:elastic                       # copy rows + embeddings from Postgres (no re-embedding)
npm run doctor                             # elastic line should be ✅

npm run compare -- "intersteller wormhole" # same query, both backends, side by side
```

Then either set `SEARCH_BACKEND=elastic` in `.env`, or choose per request:

```bash
curl -X POST localhost:3000/search -H 'content-type: application/json' \
  -d '{"query":"space survival","backend":"elastic","debug":true}'
```

Want a UI to poke at the index? `docker compose --profile elastic --profile elastic-ui up -d` and open Kibana at http://localhost:5601 (Dev Tools lets you run raw queries).

After changing data in Postgres, run `npm run sync:elastic` again. After changing the mapping in `elasticQuery.js`, run `npm run sync:elastic -- --recreate`.

---

## 3. Logging and debugging

### Log levels

| `LOG_LEVEL` | You see |
|---|---|
| `info` | One line per stage with `ms`, result counts, top result, warnings |
| `debug` (default) | + SQL statements, rule parse, analyzer output, fused ranking table, rerank movement, time-to-first-token |
| `trace` | + every mapped record during ingest, embedding input text, full RAG context |

### Debug flags (in `.env` or inline)

| Flag | What it shows | When to use |
|---|---|---|
| `LOG_SQL=true` | Every SQL + params (vectors shown as `<vector dim=768>`) and row counts | "Why zero results?" — check the WHERE clause |
| `LOG_PROMPTS=true` | Full prompts sent to Llama and raw replies | Analyzer giving weird filters, answer hallucinating |
| `LOG_VECTORS=true` | First values + norm of each embedding | Checking the model works; norm ≈ 1.0 = normalized |
| `LOG_EXPLAIN=true` | `EXPLAIN ANALYZE` of the vector query | Is the HNSW index actually used? |
| `LOG_ELASTIC=true` | Every Elastic request body (vectors summarized), `took` time, hit counts | Checking the exact query Elastic received |
| `LOG_PRETTY=false` | One JSON object per line | Piping into `jq`, log tools |
| `LOG_FILE=logs/app.log` | JSON logs to a file as well | Keep a history; grep by `reqId` |

Examples:

```bash
LOG_LEVEL=trace LOG_PROMPTS=true npm run ask -- "heist movie"
LOG_EXPLAIN=true npm run ask -- "space" --no-answer
LOG_PRETTY=false npm run ask -- "space" --no-answer | jq 'select(.stage) | {stage, ms}'
npm run ingest -- data/movies.json --limit 3 --dry-run     # see what would be embedded
```

### What the key log lines mean

| Log message | Meaning |
|---|---|
| `rule-based parse` | Filters the regexes found (years, decades, prices, ratings) |
| `analyzer proposed genres that do not exist in DB — dropped` | Llama said e.g. "sci-fi" but your data says "science fiction". Prevents empty results. |
| `query analyzed` | Final intent + filters actually used |
| `vector search → N rows` / `keyword search → N rows` | How many candidates each retriever found, with top titles |
| `fused ranking (v/k = rank in vector/keyword list)` | Where each item came from. Items in both lists rise. |
| `rerank movement (move > 0 = promoted)` | How the re-ranker reordered RRF's list. Big moves = it's earning its cost. |
| `es vector search → N rows (filters applied during the graph walk)` | Elastic kNN with pre-filtering |
| `es keyword search (BM25 + fuzzy) → N rows` | Elastic keyword search; typos still match |
| `ES ← … took: N` | `took` = Elastic's internal time; `ms` = including network |
| `bulk: some documents failed` | `_bulk` returns 200 even when docs fail — the sync checks and logs each failure |
| `answer prompt built` | How many items and roughly how many tokens go to Llama |
| `first token received` | Time-to-first-token: what a user *feels* as latency |
| `✔ llm:answer … tokPerSec` | Generation speed of your machine |
| `model was loaded from disk (cold start)` | First call after Ollama idles is slow; normal |

---

## 4. How it works internally

### Metadata vs vectors
Columns like `year`, `price`, `genres` are **metadata**: exact facts you filter with SQL. The `embedding` column is **meaning**: a 768-number vector from the embedding model, where similar meanings sit close together. Real search needs both — "under $120" is a filter, "comfy for long walks" is meaning.

### Embeddings
`nomic-embed-text` turns text into a vector. It was trained with task prefixes, so documents are embedded as `search_document: …` and queries as `search_query: …` (set in `.env`; clear them for other models). **The query and the documents must use the same model** — vectors from different models are not comparable. Changing model = re-ingest everything.

### Distance
`<=>` is pgvector's cosine distance (0 = same direction, 2 = opposite). The code reports `similarity = 1 − distance`. Other operators: `<->` (Euclidean), `<#>` (negative inner product). The index's ops class (`vector_cosine_ops`) must match the operator or the index is ignored.

### HNSW index
Checking every vector is exact but slow at scale. **HNSW** builds a layered graph: sparse long-distance links on top layers, dense local links at the bottom. A search enters at the top, greedily hops closer to the query, then drops a layer. It's *approximate*: it can miss a true neighbour.

| Setting | Where | Effect |
|---|---|---|
| `m` | `sql/schema.sql` | Links per node. More = better recall, more memory |
| `ef_construction` | `sql/schema.sql` | Build-time effort. More = better graph, slower build |
| `hnsw.ef_search` | `HNSW_EF_SEARCH` | Query-time candidate list. More = better recall, slower. Also caps how many rows HNSW can return |

On a tiny table Postgres may choose a sequential scan instead of the index — that's correct (it's cheaper). Use `LOG_EXPLAIN=true` on a bigger dataset to see the index in use.

### Filters + HNSW (a classic gotcha)
HNSW finds the nearest ~`ef_search` vectors *first*, then the `WHERE` removes non-matching rows. Strict filters can leave you with fewer results than asked. pgvector 0.8+ fixes this with **iterative scans** (`HNSW_ITERATIVE_SCAN=relaxed_order`), which keep walking the graph until enough rows pass the filter. The code detects older versions and warns once.

### Keyword search
`body_tsv` is a generated `tsvector` (stemmed words) with a GIN inverted index. It catches what embeddings are weak at: exact names, product codes, rare words. Terms are ORed so one match is enough, and `ts_rank_cd` rewards matching more of them.

### Reciprocal Rank Fusion
Cosine similarity (0–1) and `ts_rank` (unbounded) can't be added directly. RRF ignores raw scores and uses rank: `Σ 1/(k + rank)` with k = 60. An item ranked #2 in both lists beats one ranked #1 in only one list. See `test/pure.test.js`.

### Re-ranking
Embedding search is a **bi-encoder**: query and documents are embedded separately, then compared. Fast, but the model never sees them together. A **cross-encoder** reads `(query, document)` as one input and outputs a relevance score. Much more accurate, much slower — so it only scores the top ~50 candidates. This *retrieve wide, re-rank narrow* pattern is standard in production search.

### Query analyzer
Two layers. Regex rules extract exact filters (decades, "under $120", "rated over 8") deterministically. Llama, constrained by a **JSON schema** (Ollama's `format` option), extracts intent, genres and the clean semantic text. Rules win conflicts. Genres are validated against what exists in the DB. If Llama fails, it falls back to rules and logs why. Set `ANALYZER_MODE=off` to compare results with and without it.

### RAG answer
The top items are formatted as numbered `CONTEXT` and Llama is told to answer only from it and cite `[n]`. This **grounding** keeps answers tied to real catalog items. The answer streams over SSE; if the client disconnects, generation is aborted to free your CPU/GPU.

### Postgres vs Elasticsearch — what actually differs

The pipeline is identical for both; only the two retrieval functions change. That makes the differences easy to see with `npm run compare`.

| | Postgres + pgvector | Elasticsearch |
|---|---|---|
| Vector index | HNSW | HNSW (Lucene), optionally quantized |
| Filters + vectors | **Post-filter**: HNSW finds neighbours, then `WHERE` removes rows (fixed by iterative scan in pgvector 0.8+) | **Pre-filter**: the filter is applied *during* the graph walk, so you still get k results |
| Keyword search | `tsvector` + `ts_rank_cd`, exact stems only | **BM25**, field boosts (`title^3`), **typo tolerance** (`fuzziness: AUTO`), synonyms, per-language analyzers |
| Facets ("Comedy (12)") | Possible with `GROUP BY`, gets slow and awkward | **Aggregations**, built for this (see `compare` output) |
| Transactions, joins, inventory | ✅ Real ACID database | ❌ Search index, near-real-time (refresh ~1s) |
| Scaling | Vertical (bigger machine), read replicas | Horizontal: shards across nodes |
| Operating cost | One system you likely already run | Another cluster to run, size and keep in sync |

**The usual production shape:** Postgres is the source of truth (prices, stock, orders). Elastic is a search index rebuilt from it — exactly what `sync:elastic` does. In production the sync runs continuously (change events, a queue, or a scheduled job) instead of by hand.

**Score scales differ.** Elastic reports cosine kNN scores as `(1 + cos) / 2`; the code converts back to cosine so logs are comparable. BM25 and `ts_rank` are on unrelated scales, which is exactly why RRF (rank-based) is used to fuse.

**Things to try with `compare`:**
- A typo (`"intersteller"`, `"grand budapset"`): Postgres keyword search returns 0, Elastic still matches.
- A strict filter (`"comedy rated over 8 from the 90s"`): watch candidate counts per backend.
- A descriptive query (`"lonely survival far from home"`): both should agree, since vectors do the work.

---

## 5. Using your own data

All adaptation happens in **`src/ingest/mapping.js`** (`toItem`). It already handles both bundled files:

```bash
npm run ingest -- data/products.sample.json        # product-style records
npm run ingest -- path/to/yours.json --reset       # wipe, then load yours
```

Guidelines:
1. **`body` is what gets searched by meaning.** Include descriptive text and labelled facts ("Category: running. Color: black."). Leave out noise like IDs and URLs.
2. **Filterable facts go in columns** (`year`, `price`, `rating`, `genres`, `category`). Add columns in `schema.sql` + `filters.js` + the analyzer `SCHEMA` for new filters (size, gender, color…).
3. **Keep `genres`/tags lowercase and consistent** — the analyzer can only filter on values that exist.
4. **Changing embedding model?** Update `EMBED_MODEL`, `EMBED_DIM`, `vector(N)` in `schema.sql`, the prefixes, then `npm run db:init && npm run ingest`.

### For a Nike-style product catalog
- Put style, use-case and feel words in `body` ("responsive foam for long road runs, breathable mesh").
- Make `category`, `color`, `price`, `size`, `gender` real columns so "black running shoes under $120 in size 10" is mostly SQL.
- Keyword search matters more for products: style codes and model names (e.g. exact product line names) should match exactly.
- Chunking isn't needed for short product records; it matters for long documents (reviews, guides): split into ~300–500 token chunks with a parent product ID.

---

## 6. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Ollama unreachable` | Start Ollama (`ollama serve` or the app). Check `OLLAMA_URL`. |
| `Ollama error — run: ollama pull …` | Model not downloaded. |
| `Embedding dimension mismatch` | Model output ≠ `EMBED_DIM` / `vector(N)`. See section 5, point 4. |
| `0 results WITH filters` warning | Filters too strict or wrong. Check `query analyzed` log; try `ANALYZER_MODE=rules` or `off`. |
| Fewer results than `k` | Filters + HNSW (see section 4). Use pgvector ≥ 0.8 with iterative scan, or raise `HNSW_EF_SEARCH`. |
| `keyword search → 0 rows` | Normal for descriptive queries; vector search covers it. |
| First request very slow | Model cold-start (log says so). Later calls are fast. |
| `relation "items" does not exist` | `npm run db:init` |
| `Elasticsearch unreachable` | `docker compose --profile elastic up -d`; wait ~30s for it to start |
| Elastic `index_not_found` / `docs: 0` | `npm run sync:elastic` |
| Elastic results stale after changing Postgres | Re-run `npm run sync:elastic` (it upserts) |
| Elastic `strict_dynamic_mapping_exception` | Field not in the mapping: add it in `elasticQuery.js`, then `sync:elastic -- --recreate` |
| Elastic container exits immediately | Give Docker ≥ 2 GB RAM; on Linux you may need `sysctl -w vm.max_map_count=262144` |
| Docker DB has an old schema | Init scripts only run on an empty volume: `docker compose down -v && docker compose up -d` |

---

## 7. Scripts

| Command | Does |
|---|---|
| `npm run doctor` | Checks Postgres, pgvector, table, Ollama models, reranker — with fix hints |
| `npm run db:init` | Drops and recreates the schema |
| `npm run ingest -- [file] [--reset] [--limit N] [--batch N] [--dry-run]` | Map → embed → upsert |
| `npm run ask -- "query" [--no-answer]` | Full pipeline in the terminal with tables (uses `SEARCH_BACKEND`) |
| `npm run sync:elastic [-- --recreate] [--batch N]` | Copy Postgres rows + embeddings into Elastic |
| `npm run compare -- "query"` | Same query through Postgres and Elastic, side by side, plus facets |
| `npm run dev` / `npm start` | API with/without auto-reload |
| `npm test` | Unit tests for rules, filters, RRF, mapping, Elastic query builders (no services needed) |

---

## 8. Where to go next

1. **Build an evaluation set** — 30–50 real queries with the items you expect; measure hit rate in the top 10 after every change. Without this, tuning is guessing.
2. **Compare modes** with the same query: `ANALYZER_MODE=off`, `RERANK_MODE=none` vs `cross-encoder`, and read the `rrf`/`rerank` columns in `npm run ask`.
3. **Cache query embeddings** for popular queries.
4. **Port to Spring Boot** — Spring AI has pgvector and Ollama support; the SQL, prompts and pipeline order carry over unchanged.
5. **Scale up** — at millions of rows, look at `halfvec` (half the memory), partitioning by category, and comparing HNSW vs IVFFlat build/query trade-offs.
