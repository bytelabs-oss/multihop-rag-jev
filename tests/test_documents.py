import unittest
from server.documents import CANDIDATE_MULTIPLIER, hybrid_search, populate_index, project, search
from qdrant_client import QdrantClient, models


class LibraryIntegrationTests(unittest.TestCase):
    def test_returns_top_k_from_full_corpus_without_neighbor_expansion(self):
        # The best evidence occurs last, so slicing the corpus first would fail.
        chunks = [{'id': str(i), 'index': i, 'docId': 'book', 'section': 'same',
                   'vector': [float(i+1), 100.]} for i in range(80)]
        empty = models.SparseVector(indices=[], values=[])
        result = hybrid_search(chunks, [1., 0.], empty, [empty] * len(chunks), 10, -1)
        self.assertEqual([c['id'] for c in result], [str(i) for i in range(79, 69, -1)])
        self.assertEqual([c['label'] for c in result], [f'C{i}' for i in range(1, 11)])
        self.assertTrue(all(c['retrievalReason'] == 'hybrid match' for c in result))

    def test_lexical_evidence_enters_fused_top_k(self):
        chunks = [{'id': str(i), 'index': i, 'docId': 'book', 'section': 'same',
                   'vector': [float(i+1), 100.]} for i in range(20)]
        empty = models.SparseVector(indices=[], values=[])
        term = models.SparseVector(indices=[7], values=[1.])
        result = hybrid_search(chunks, [1., 0.], term, [term] + [empty] * 19, 2, .15)
        self.assertEqual({c['id'] for c in result}, {'0', '19'})
        self.assertGreater(next(c for c in result if c['id'] == '0')['bm25Score'], 0)
        self.assertIsNone(next(c for c in result if c['id'] == '0')['semanticRank'])
        self.assertEqual(len(result), 2)

    def test_small_corpus_and_invalid_counts(self):
        chunks = [{'id': 'only', 'index': 0, 'docId': 'book', 'vector': [1., 0.]}]
        empty = models.SparseVector(indices=[], values=[])
        self.assertEqual(len(hybrid_search(chunks, [1., 0.], empty, [empty], 10, .5)), 1)
        for count in [0, -1, 1.5, True]:
            with self.assertRaises(ValueError):
                hybrid_search(chunks, [1., 0.], empty, [empty], count, .5)

    def test_weak_dense_matches_do_not_fill_the_candidate_limit(self):
        chunks = [
            {'id': 'strong', 'index': 0, 'docId': 'book', 'vector': [1., 0.]},
            {'id': 'moderate', 'index': 1, 'docId': 'book', 'vector': [.6, .8]},
            {'id': 'weak', 'index': 2, 'docId': 'book', 'vector': [.3, .95]},
            {'id': 'lexical', 'index': 3, 'docId': 'book', 'vector': [0., 1.]},
        ]
        empty = models.SparseVector(indices=[], values=[])
        term = models.SparseVector(indices=[7], values=[1.])
        result = hybrid_search(chunks, [1., 0.], term, [empty, empty, empty, term], 50, .5)
        self.assertEqual({c['id'] for c in result}, {'strong', 'moderate', 'lexical'})
        self.assertEqual(len(result), 3)
        self.assertEqual([c['label'] for c in result], ['C1', 'C2', 'C3'])
        self.assertEqual([c['retrievalRank'] for c in result], [1, 2, 3])
        lexical = next(c for c in result if c['id'] == 'lexical')
        self.assertIsNone(lexical['semanticRank'])
        self.assertGreater(lexical['bm25Score'], 0)

    def test_branch_candidates_are_bounded_by_top_k_times_multiplier(self):
        # Regression test for the efficient hybrid-search pattern: each
        # branch's candidate pool is bounded to top_k * CANDIDATE_MULTIPLIER
        # (not the full corpus, and not top_k itself), and the fused query's
        # own limit is exactly top_k, since Qdrant's limit already performs
        # the final cut without backfilling.
        chunks = [{'id': str(i), 'index': i, 'docId': 'book', 'vector': [1., .01 * i]} for i in range(12)]
        empty = models.SparseVector(indices=[], values=[])
        client = QdrantClient(':memory:')
        top_k = 1
        expected_candidate_k = min(top_k * CANDIDATE_MULTIPLIER, len(chunks))
        self.assertLess(expected_candidate_k, len(chunks), 'test requires a bounded (not full-corpus) candidate_k')
        try:
            populate_index(client, chunks, [empty] * len(chunks))
            original = client.query_points
            limits = []

            def spy(*args, **kwargs):
                limits.append(kwargs.get('limit'))
                return original(*args, **kwargs)

            client.query_points = spy
            result = hybrid_search(chunks, [1., 0.], empty, [empty] * len(chunks), top_k, -1, client=client)
        finally:
            client.close()
        self.assertEqual(len(result), top_k)
        # dense_hits, sparse_hits, then the fused query.
        self.assertEqual(limits, [expected_candidate_k, expected_candidate_k, top_k])

    def test_no_qualifying_hits_returns_no_candidates(self):
        chunks = [{'id': str(i), 'index': i, 'docId': 'book', 'vector': [0., 1.]} for i in range(80)]
        empty = models.SparseVector(indices=[], values=[])
        result = hybrid_search(chunks, [1., 0.], empty, [empty] * len(chunks), 50, .5)
        self.assertEqual(result, [])
        self.assertEqual(hybrid_search([], [1., 0.], empty, [], 50, .5), [])

    def test_vector_scores_must_exceed_the_cutoff(self):
        chunks = [{'id': 'exact', 'index': 0, 'docId': 'book', 'vector': [1., 0.]}]
        empty = models.SparseVector(indices=[], values=[])
        self.assertEqual(hybrid_search(chunks, [1., 0.], empty, [empty], 50, 1), [])
        self.assertEqual(len(hybrid_search(chunks, [1., 0.], empty, [empty], 50, .99)), 1)

    def test_changing_the_cutoff_filters_a_reused_index(self):
        chunks = [
            {'id': 'strong', 'index': 0, 'docId': 'book', 'vector': [1., 0.]},
            {'id': 'moderate', 'index': 1, 'docId': 'book', 'vector': [.6, .8]},
        ]
        empty = models.SparseVector(indices=[], values=[])
        client = QdrantClient(':memory:')
        try:
            populate_index(client, chunks, [empty, empty])
            permissive = hybrid_search(chunks, [1., 0.], empty, None, 50, .5, client=client)
            selective = hybrid_search(chunks, [1., 0.], empty, None, 50, .8, client=client)
            self.assertEqual({c['id'] for c in permissive}, {'strong', 'moderate'})
            self.assertEqual([c['id'] for c in selective], ['strong'])
            self.assertEqual(client.count('passages').count, 2)
        finally:
            client.close()

    def test_invalid_cutoffs_fail_before_embedding_or_searching(self):
        empty = models.SparseVector(indices=[], values=[])
        for cutoff in [None, True, False, '0.5', float('nan'), float('inf'), float('-inf'), -1.01, 1.01]:
            with self.subTest(cutoff=cutoff):
                with self.assertRaisesRegex(ValueError, 'Minimum vector similarity'):
                    hybrid_search([], [1., 0.], empty, [], 50, cutoff)
                with self.assertRaisesRegex(ValueError, 'Minimum vector similarity'):
                    search({'chunks': [], 'topK': 50, 'semanticThreshold': cutoff})

    def test_pca_uses_every_vector_and_handles_identical_vectors(self):
        self.assertEqual(project({'vectors': [[1., 0.], [1., 0.]]})['coordinates'], [[0, 0], [0, 0]])
        self.assertEqual(len(project({'vectors': [[1., 0.], [0., 1.], [-1., 0.]]})['coordinates']), 3)


if __name__ == '__main__':
    unittest.main()

class ChunkOverflowTests(unittest.TestCase):
    def test_table_heading_overflow_preserves_every_row(self):
        import io
        from server.documents import MODEL, bounded_chunks
        from docling.document_converter import DocumentConverter
        from docling.datamodel.base_models import DocumentStream
        from transformers import AutoTokenizer
        tokenizer = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
        source = '# ' + ('Detailed textbook section ' * 30) + '\n\n| Item | Explanation |\n| --- | --- |\n'
        source += '\n'.join(f'| Marker{i} | A distinct explanation of this process and its implications. |' for i in range(150))
        doc = DocumentConverter().convert(DocumentStream(name='table.md', stream=io.BytesIO(source.encode()))).document
        chunks = list(bounded_chunks(doc, tokenizer))
        self.assertTrue(any(c[4] for c in chunks), 'Fixture must exercise the overflow fallback')
        self.assertTrue(all(c[3] <= tokenizer.model_max_length for c in chunks))
        import re
        markers = re.findall(r'Marker\d+', '\n'.join(c[1] for c in chunks))
        self.assertEqual(markers, [f'Marker{i}' for i in range(150)])
        self.assertTrue(all(c[0].meta.doc_items for c in chunks))

class CorpusSentenceTests(unittest.TestCase):
    def test_sentence_splitter_preserves_article_text_and_metadata(self):
        from server.documents import corpus_chunks
        article = {'title': 'Export policy', 'source': 'Policy desk', 'published_at': '2026-01-02',
                   'body': ' '.join(f'Record{i} describes a separate evidence retention requirement.' for i in range(180))}
        chunks = corpus_chunks(article)
        self.assertGreater(len(chunks), 1)
        covered = [False] * len(article['body'])
        for chunk in chunks:
            self.assertEqual(chunk['chunker'], 'llama_index.SentenceSplitter')
            self.assertEqual((chunk['chunkSize'], chunk['chunkOverlap']), (256, 25))
            self.assertIn('Policy desk', chunk['text'])
            self.assertIn('2026-01-02', chunk['text'])
            self.assertLessEqual(chunk['tokenCount'], 512)
            self.assertEqual(article['body'][chunk['start']:chunk['end']], chunk['body'])
            covered[chunk['start']:chunk['end']] = [True] * (chunk['end'] - chunk['start'])
        self.assertTrue(all(found or char.isspace() for found, char in zip(covered, article['body'])))
        self.assertTrue(any(a['end'] > b['start'] for a, b in zip(chunks, chunks[1:])))

    def test_questions_are_never_imported_as_articles(self):
        from server.documents import corpus_chunks
        with self.assertRaises(ValueError):
            corpus_chunks({'title': 'Fake', 'body': 'Text', 'answer': 'Answer key'})
