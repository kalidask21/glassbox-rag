"""
Optional cross-encoder re-ranking service.

A cross-encoder reads (query, document) TOGETHER and outputs one relevance score.
That's more accurate than comparing two separate embeddings, but too slow to run
over the whole catalog, so Node only sends it the top ~50 candidates.

POST /rerank  {"query": "...", "documents": ["...", "..."]}  ->  {"scores": [..]}
"""
import logging
import os
import time

from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import CrossEncoder

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s reranker: %(message)s")
log = logging.getLogger("reranker")

MODEL_NAME = os.getenv("RERANK_MODEL", "BAAI/bge-reranker-base")
log.info("loading model %s (first run downloads it)", MODEL_NAME)
t0 = time.perf_counter()
model = CrossEncoder(MODEL_NAME, max_length=512)
log.info("model loaded in %.1fs", time.perf_counter() - t0)

app = FastAPI()


class RerankRequest(BaseModel):
    query: str
    documents: list[str]


@app.get("/health")
def health():
    return {"model": MODEL_NAME}


@app.post("/rerank")
def rerank(req: RerankRequest):
    t = time.perf_counter()
    if not req.documents:
        return {"scores": [], "model": MODEL_NAME, "ms": 0}
    scores = model.predict([(req.query, d) for d in req.documents]).tolist()
    ms = round((time.perf_counter() - t) * 1000, 1)
    best = max(range(len(scores)), key=lambda i: scores[i])
    log.info("query=%r docs=%d ms=%s best=%d score=%.3f", req.query[:80], len(scores), ms, best, scores[best])
    return {"scores": scores, "model": MODEL_NAME, "ms": ms}
