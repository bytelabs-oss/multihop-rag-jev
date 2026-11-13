# multihop-rag-jev

Tests TypeSafe's Jev model as a relevance filter in retrieval-augmented question answering, on the [MultiHop-RAG](https://github.com/yixuantt/MultiHop-RAG) corpus or your own documents. The app is called Atlas.

Documents are chunked and embedded locally. Each question runs in four modes that share one answer model (`openai/gpt-5-mini`):

- **Hybrid baseline.** Qdrant vector search plus BM25, fused with RRF, returns up to 20 passages. All of them go to the answer model.
- **Hybrid + Jev.** The same 20 passages. Jev judges each one for relevance, then checks whether it adds anything to the passages already kept. Only the kept passages go to the answer model.
- **Keyword search (rg).** The answer model searches the raw document text with regular expressions, ripgrep-style, and reads every match.
- **Keyword search (rg) + Jev.** The same search, but Jev checks each new match before the answer model sees it.

The trace shows the exact Jev questions, raw answers, selection steps, answer context, tokens and cost for every mode. A separate benchmark page runs the modes over all 609 articles and 2,556 questions.

- [PRODUCT.md](./PRODUCT.md): what the experiment does and its constraints
- [SETUP.md](./SETUP.md): how to install and run it
- [LOCAL-PIPELINE.md](./LOCAL-PIPELINE.md): the pipeline, libraries and data lifetime

Put `TYPESAFE_API_KEY` and `AI_GATEWAY_API_KEY` in `.env.local`.

The MultiHop-RAG data under `public/datasets/multihop-rag/` keeps its own licence; see its `ATTRIBUTION.md`. The app is built on a vinext starter; the `scripts/` folder and the `start` and `build` scripts come from that template.
