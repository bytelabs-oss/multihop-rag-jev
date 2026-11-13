# Local document pipeline

The document and JEV APIs are local Vite middleware; the static production build alone does not provide these APIs.

## Libraries

- Corpus JSON imports use `llama-index-core==0.14.24` and `SentenceSplitter(chunk_size=256, chunk_overlap=25)`, matching the explicit configuration in MultiHop-RAG's `simple_retrieval.py`. Article bodies go directly to the splitter with title, publication date and source metadata. LlamaIndex accounts for metadata in its chunk budget. Its default tokenizer counts these 256 tokens; BGE's tokenizer separately checks the actual 512-token embedding window. Oversize input fails without truncation. This uses the current core package, not the reference repository's older full LlamaIndex installation. Qdrant retrieval and both comparison modes are unchanged.

- Docling 2.129.0 parses PDF, DOCX, Markdown and text. PDFs use local layout, table and OCR models. A partial conversion fails instead of creating an incomplete index.
- `docling.chunking.HybridChunker` respects document structure, merges compatible neighboring fragments, and splits oversized content using the embedding model's tokenizer. This is structure-aware chunking, not the removed adjacent-sentence cosine heuristic.
- `HybridChunker.contextualize()` includes heading context in each chunk's text. That exact text is embedded and shown to JEV. Page ranges and Docling source-item references remain available in the inspector.
- FastEmbed 0.8.0 runs `BAAI/bge-small-en-v1.5` locally and returns 384-dimensional vectors. The same model embeds questions with its retrieval instruction. Docling table chunks that overflow after heading context is added are split further with semchunk 3.2.5. The final token check includes encoder special tokens. The application does not silently truncate passages. Oversized questions fail visibly.
- Qdrant client 1.19.1 runs a temporary `:memory:` collection. FastEmbed's `Qdrant/bm25` supplies sparse vectors and Qdrant supplies corpus IDF, cosine search and reciprocal-rank fusion. Vector search admits scores above the configured vector cutoff. BM25 admits positive keyword scores independently, so a keyword match can qualify below the vector cutoff. Each branch returns at most K eligible hits, and RRF returns at most K fused candidates without filling unused slots. K defaults to 20 and is adjustable with Maximum candidates. Both hybrid modes share the exact same result.
- No neighboring chunks are appended after ranking.
- scikit-learn 1.9.1 computes the displayed PCA coordinates. Search uses original 384-dimensional vectors, never those 2D positions.

JEV relevance runs in batches of 24 until every retrieved candidate has been evaluated. JEV contribution checks run against previously kept evidence. Exact duplicates and low-scoring chunks are dropped. The answer model receives every retained passage with citation labels. Actual provider input-window errors are reported instead of silently reducing the evidence.

## Fixed retrieval filters

The app fixes the vector cutoff at 0.5 and requires positive BM25 keyword scores. Neither filter has a UI control. The vector cutoff is a BGE cosine score, not a probability or a JEV threshold. Qdrant requires a vector score to exceed it. Positive BM25 matches still qualify independently. If neither branch finds a qualifying hit, retrieval returns no candidates. It never restores rejected passages to reach the maximum. Maximum candidates remains adjustable, and JEV relevance applies only after shared retrieval. Retrieval does not read dataset questions, reference answers, or evidence labels.

Both initial hybrid runs use the same cutoff and maximum. The optional rewritten-query retry preserves these settings but retrieves a new candidate set. GPT keyword search is unchanged.

## Dataset questions

The official `MultiHopRAG.json` is bundled beside `corpus.json` under `public/datasets/multihop-rag/`, at the same pinned revision. Ingestion remains article-first. The question browser offers only non-null questions whose required source articles are all currently loaded. It reads question types and supporting-source URLs to determine availability, but retains no reference answers or evidence facts. The corpus's existing content IDs connect these URLs to loaded documents, including older saved caches without URL fields. Reading the corpus for this lookup does not ingest or embed additional articles.

Availability follows the entire loaded document set and updates when articles are added, removed, or restored. It is independent of the example-set size. For the pinned files, the first 10 articles cover 11 answerable questions; the first 100 cover 563. Ordinary examples exclude intentional `null_query` no-answer controls. If no questions are fully covered, the browser explains that more dataset sources are needed instead of falling back to unsupported questions.

Questions appear as full-text selectable rows. The browser shows up to 10 shuffled examples initially, with 25/50/all options and New examples. Lists longer than 20 questions are paginated. Search checks every available question for the loaded corpus, not just the displayed example set. Every entered word must appear in the question, ignoring case. Example-set controls pause while searching; clearing the search restores the sample.

Escape or Close preserves the chat draft. Selecting a row fills the normal input for editing; it does not submit, load articles, restrict retrieval to gold sources, or change retrieval settings. Retrieval still searches every loaded document. Reference answers and evidence facts never enter the document index or model inputs. Source coverage makes a question eligible, but does not guarantee retrieval or answer accuracy.

## Data lifetime

Parsed documents and dense vectors are saved in browser IndexedDB, with portable JSON cache export/import. Completed corpus articles are saved individually so interrupted imports resume without embedding them again. Content hashes include the chunking and embedding configuration. Chat stays in memory. Original uploaded files are not persisted. Local processing uses one Python process per browser session, in-memory byte streams, and an in-memory Qdrant collection. The model and index are reused across questions. Changing the document set rebuilds the index. Closing or refreshing the tab releases the process; abandoned sessions expire after ten minutes without a heartbeat. Cancelling a processing request terminates its process. There is no authentication or server-side upload folder. The public corpus is bundled under public/datasets/multihop-rag with provenance and attribution. Browser cache data is not part of the source tree.

`.model-cache` contains downloaded public model artifacts only. `.venv` contains installed software. Neither contains private document caches. Asking a question sends retrieved passages to JEV and retained passages to the answer provider through the existing server-side gateway configuration.

Setup commands are in [SETUP.md](./SETUP.md).

## Verification and limits

```sh
node --test tests/pipeline.test.mjs
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
npx tsc --noEmit
npm run build
```

The adapter tests exercise real Qdrant rank fusion, score-filtered retrieval, empty and below-cap results, cutoff changes on a reused index, score ordering and scikit-learn projection. JEV tests use deterministic provider stubs to verify filtering, cancellation and evidence forwarding. Synthetic PDF, DOCX and Markdown checks exercise actual Docling and FastEmbed locally.

No chunker guarantees perfect boundaries or retrieval recall. PDF reading order, OCR and table recognition can be imperfect. A 500-page user textbook has not been benchmarked. The first search builds the index. Subsequent searches reuse it and send only the question and corpus identifier, while the documents remain loaded. JEV contribution checks are sequential because each check depends on the evidence already kept.

Sources: [Docling chunking](https://docling-project.github.io/docling/concepts/chunking/), [Qdrant hybrid queries](https://qdrant.tech/documentation/search/hybrid-queries/), [BGE model](https://huggingface.co/BAAI/bge-small-en-v1.5).

## Full benchmark

Benchmark opens `/benchmark` in a separate tab, leaving the current workspace intact. It runs the existing retrieval-to-answer pipelines across all 609 corpus articles and all 2,556 questions, including the 301 intentional no-answer cases. It does not use the ordinary picker's source-coverage filter. Private uploads are not included. Dataset checksums are verified against the bundled manifest.

The operator selects modes, confirms provider charges, and presses Start full benchmark. Corpus preparation reuses saved embeddings and processes missing dataset articles locally. Both hybrid modes reuse one candidate set per question; keyword mode keeps its existing independent retrieval. Automatic query rewriting is disabled for this comparison. Reference answers, evidence facts, and question types never enter retrieval or generation requests.

Progress and per-question/mode results are saved in the separate `atlas-benchmarks` IndexedDB database. Detailed traces are gzip-compressed and loaded only when a question is opened. Pause aborts current work. Resume skips settled modes and reuses a saved hybrid candidate set. An interrupted request may already have incurred charges; incomplete usage remains unreported, and previous attempts remain inspectable. A per-job browser lock prevents two tabs from running the same saved benchmark simultaneously.

Context-window and incomplete-answer failures are recorded per case. Credential, rate-limit, transport, and storage failures stop the batch. Failed calls do not become no-answer predictions. Deliberate pipeline abstention is scored with the standard `Insufficient information.` marker and remains visible as abstention. Partial or failed runs are not labeled as fully scored results.

Scoring follows the official repository at commit `c1c1287aa60a94acf9c4d20c891c9cd611a0f6e8`, with important caveats:

- Retrieval uses the exact gold fact inside a retrieved chunk after removing ordinary spaces and newlines, preserving case. Hits@4/10 and MRR@10 are reported. The repository's MAP@10 sums newly found facts divided by their rank, then divides by `min(number of gold facts, 10)`. This is not textbook average precision. Null queries are excluded from retrieval scores.
- Answer scoring optionally extracts `The answer to the question is "..."`, lowercases, and checks for any shared whitespace-delimited token with the reference. The UI labels this a repository overlap score, not semantic accuracy or normal token F1. No judge-model call is needed.
- Scores use completed predictions and show their denominators. Failures, pending cases, and missing usage remain explicit. Retrieval candidates and passages retained for the answer have separate evidence scores.

The overall view includes answer-step and whole-run costs/tokens, question-type results, and per-question inspection of answers, retrieved passages, model requests, and charts. Export contains the job configuration, pricing snapshot, overall metrics, and question results. It is an Atlas report, not the input format of the standalone upstream scripts. Detailed traces remain in the browser.

This is an Atlas evaluation on MultiHop-RAG, not a reproduction of the paper's models or context budget. Do not change pipeline code during a saved run. Model aliases and configuration are recorded, but a provider can change the model behind a `latest` alias. Do not interpret the permissive overlap score as proof of correctness.

Sources: [official retrieval evaluator](https://github.com/yixuantt/MultiHop-RAG/blob/c1c1287aa60a94acf9c4d20c891c9cd611a0f6e8/retrieval_evaluate.py), [official answer evaluator](https://github.com/yixuantt/MultiHop-RAG/blob/c1c1287aa60a94acf9c4d20c891c9cd611a0f6e8/qa_evaluate.py), [paper](https://arxiv.org/abs/2401.15391).

## Comparison retries and display

The left sidebar keeps the document list in a bounded scroll area so a large corpus cannot push retrieved evidence below it. New runs default to Retrieved, the full candidate set before model selection. Kept and Dropped show later decisions and have separate counts. An empty completed retrieval is distinguished from retrieval still in progress.

Comparison charts separate the common GPT answer-generation step from whole-run totals. GPT answer tokens and cost exclude keyword planning, query rewriting, and JEV calls. Whole-run totals include every recorded model call, and elapsed time includes retrieval. A skipped answer is Not called, not a zero-cost completed answer. Missing usage stays unreported. Non-JEV runs have no JEV usage row or input tab; their model breakdown shows only applicable work. Exports retain per-model totals and include the answer-only and whole-run metrics.

The optional retry is one query rewrite and retrieval after JEV keeps zero passages. It creates a separate result, preserves the original question, and includes first-pass usage in its cumulative totals. The baseline is unchanged. A low score is not proof of missing evidence, and two retained chunks may be sufficient; this is why partial results do not automatically loop.

The point map uses one canvas, drawing all points with requestAnimationFrame during panning. Lists are paginated for rendering only; retrieval still searches all indexed chunks. PCA coordinates are cached for a matching document collection.
