import 'dotenv/config';

const bool = (v, d = false) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
// Keep trailing spaces in prefixes (e.g. "search_query: "), so no trim here.
const str = (v, d) => (v === undefined ? d : v);

export const config = {
  port: num(process.env.PORT, 3000),

  // Which store serves retrieval: postgres | elastic (Postgres stays the source of truth either way)
  searchBackend: str(process.env.SEARCH_BACKEND, 'postgres'),
  elastic: {
    url: str(process.env.ELASTIC_URL, 'http://localhost:9200').replace(/\/$/, ''),
    index: str(process.env.ELASTIC_INDEX, 'items'),
    // How many graph candidates each shard explores for kNN (Elastic's ef_search equivalent)
    numCandidates: num(process.env.ELASTIC_NUM_CANDIDATES, 100),
  },

  databaseUrl: str(process.env.DATABASE_URL, 'postgres://postgres:postgres@localhost:5432/vectors'),
  hnsw: {
    efSearch: num(process.env.HNSW_EF_SEARCH, 100),
    iterativeScan: str(process.env.HNSW_ITERATIVE_SCAN, 'relaxed_order'),
  },

  ollamaUrl: str(process.env.OLLAMA_URL, 'http://localhost:11434').replace(/\/$/, ''),
  embedModel: str(process.env.EMBED_MODEL, 'nomic-embed-text'),
  embedDim: num(process.env.EMBED_DIM, 768),
  embedDocPrefix: str(process.env.EMBED_DOC_PREFIX, 'search_document: '),
  embedQueryPrefix: str(process.env.EMBED_QUERY_PREFIX, 'search_query: '),
  chatModel: str(process.env.CHAT_MODEL, 'llama3.1:8b'),

  analyzerMode: str(process.env.ANALYZER_MODE, 'llm'),
  rerankMode: str(process.env.RERANK_MODE, 'auto'),
  rerankerUrl: str(process.env.RERANKER_URL, '').replace(/\/$/, ''),

  search: {
    candidateK: num(process.env.SEARCH_CANDIDATE_K, 50),
    finalK: num(process.env.SEARCH_FINAL_K, 8),
    rrfK: num(process.env.RRF_K, 60),
  },

  log: {
    level: str(process.env.LOG_LEVEL, 'debug'),
    pretty: bool(process.env.LOG_PRETTY, true),
    file: str(process.env.LOG_FILE, 'logs/app.log'),
    sql: bool(process.env.LOG_SQL, true),
    prompts: bool(process.env.LOG_PROMPTS, false),
    vectors: bool(process.env.LOG_VECTORS, false),
    explain: bool(process.env.LOG_EXPLAIN, false),
    elastic: bool(process.env.LOG_ELASTIC, true),
  },
};
