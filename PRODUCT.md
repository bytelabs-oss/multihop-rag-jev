# Atlas
<!-- impeccable:product-schema 1 -->
## Platform
web
## Purpose
Upload documents to view chunks as nodes in semantic vector space. The user asks questions and inspects retrieval, JEV judgments, filtering, and cited answers.
## Confirmed constraints
No authentication. No storage. Documents and chunks are held only in browser memory during the current tab session. Run the website locally. Embedding and retrieval stay in the browser. When the user asks a question, retrieved candidate passages go through a loopback Node middleware to JEV via AI Gateway. Only selected passages go to the answer model. The app does not persist documents, questions, or responses.
## Implementation
PDF, DOCX, TXT and Markdown extraction, browser MiniLM embeddings, PCA display, cosine neighbors, source offsets and PDF page references. The browser downloads model assets, but no document content is sent with these requests.

## Experiment focus
The user does not want responsive design or visual polish work. Prioritize processing behavior and inspectable experimental results.

## JEV experiment
Reuse only the JEV and model integration from jev-document-router, not its routing flow. Both hybrid comparison modes share one Qdrant retrieval result. Vector search accepts cosine scores above the fixed 0.5 cutoff. Positive BM25 hits qualify independently. Neither retrieval score filter is adjustable in the UI. RRF ranks these qualifying hits and returns at most the configured maximum, initially 20, without filling unused slots. The hybrid baseline sends that result to GPT; JEV applies additional relevance and contribution judgments before GPT. No surviving chunks means no answer-model call. Each question is an independent run. The trace retains exact questions, retrieval settings, raw JEV responses, selection steps, answer context and usage in browser memory only.

## Dataset questions
Ingestion is article-first. Browse dataset questions offers only answerable questions whose source articles are all currently loaded. Question types and supporting-source URLs from the official MultiHopRAG.json determine availability by matching the corpus's content IDs; reference answers and evidence facts are not retained or sent to models. Availability updates when documents are loaded, removed, or restored, without re-embedding existing articles.

The browser shows full question text in selectable rows, starting with up to 10 shuffled examples and offering 25/50/all choices. These counts control displayed examples, not ingestion. Search covers all eligible questions for the loaded corpus. Long lists are paginated. Selecting a question only fills the chat input; closing preserves the draft. No question is hardcoded or automatically submitted, and retrieval remains unchanged.

## Full benchmark
The separate benchmark page runs the existing end-to-end modes over the complete pinned corpus and all questions, including intentional no-answer cases. Starting requires explicit confirmation of provider charges. Completed work is saved, resumable, and inspectable by question and mode. Overall results distinguish partial coverage, failures, answer-step usage, and whole-run usage. References are used only for local scoring. The official repository's permissive answer-overlap score is clearly labeled and is not presented as semantic accuracy.
