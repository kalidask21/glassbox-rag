-- Runs automatically on first `docker compose up` (mounted into docker-entrypoint-initdb.d),
-- or manually with `npm run db:init` (which DROPS and recreates the table).

CREATE EXTENSION IF NOT EXISTS vector;

DROP TABLE IF EXISTS items;

CREATE TABLE items (
  id           BIGSERIAL PRIMARY KEY,
  external_id  TEXT UNIQUE NOT NULL,          -- id from your JSON (movie id, Nike style code...)

  -- ---- Metadata: exact, filterable facts ----
  title        TEXT NOT NULL,
  category     TEXT,                          -- e.g. movie | running | basketball
  genres       TEXT[] NOT NULL DEFAULT '{}',  -- lowercase tags; filtered with && (overlap)
  year         INT,
  price        NUMERIC(10,2),
  rating       NUMERIC(3,1),
  doc          JSONB NOT NULL,                -- the full original record, untouched

  -- ---- Text used for search ----
  body         TEXT NOT NULL,                 -- what gets embedded
  body_tsv     TSVECTOR GENERATED ALWAYS AS
                 (to_tsvector('english', coalesce(title, '') || ' ' || body)) STORED,

  -- ---- Meaning: the embedding ----
  -- The number MUST equal EMBED_DIM (nomic-embed-text = 768).
  embedding    VECTOR(768),

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Approximate nearest neighbour index (graph). cosine ops pair with the <=> operator.
--   m               = links per node (more = better recall, more memory)
--   ef_construction = effort while building (more = better graph, slower build)
CREATE INDEX items_embedding_hnsw ON items
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- Keyword search (inverted index over the tsvector)
CREATE INDEX items_body_tsv_gin ON items USING gin (body_tsv);

-- Metadata filters
CREATE INDEX items_genres_gin ON items USING gin (genres);
CREATE INDEX items_year_idx   ON items (year);
CREATE INDEX items_price_idx  ON items (price);
