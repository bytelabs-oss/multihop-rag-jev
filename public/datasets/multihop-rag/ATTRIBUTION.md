# MultiHop-RAG dataset

By Yixuan Tang and Yi Yang. Source: https://huggingface.co/datasets/yixuantt/MultiHopRAG

This dataset is made available under the Open Data Commons Attribution License v1.0: https://opendatacommons.org/licenses/by/1-0/

The bundled `corpus.json` and `MultiHopRAG.json` are unmodified copies from revision `71ac0d0`. Individual articles retain their source metadata.

The corpus loader reads articles from `corpus.json`. The optional question picker reads only the `query` fields from `MultiHopRAG.json`. Its reference answers and evidence annotations are not indexed or sent to model providers.
