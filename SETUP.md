# Run the local experiment

Use Python 3.12 and the existing Node installation:

```sh
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.lock.txt
.venv/bin/docling-tools models download layout tableformer rapidocr --output-dir .model-cache/docling
npm install
npm run dev -- --port 5173
```

The embedding/tokenizer models download on first use. Subsequent runs reuse their cached files. Exact Python dependencies are recorded in `requirements.lock.txt`.


See [LOCAL-PIPELINE.md](./LOCAL-PIPELINE.md) for the pipeline and data lifetime.

## Corpus and saved embeddings

`public/datasets/multihop-rag/` includes the public corpus, a pinned-source manifest, and attribution. Include this directory when committing or deploying the project. The loader reads this bundled asset; it does not fetch the corpus from Hugging Face at runtime.

Parsed chunks and embeddings are cached in the browser. Export the cache before changing machines, browser profiles, or site URLs, then import it at the destination. Browser data can be cleared or evicted; the exported JSON is a portable backup. Cache files contain passage text, so private upload caches should not be committed to a public repository.

A static build includes the corpus asset but not a running Python/model backend. Deployment still needs the local API equivalents and credentials; this change does not deploy those services.
