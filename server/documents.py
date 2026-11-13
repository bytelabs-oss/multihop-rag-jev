"""One process per browser session. Uploaded bytes, parsed documents and indexes stay in RAM."""
import base64
import io
import json
import os
import sys
import time
import hashlib
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault('HF_HOME', str(ROOT / '.model-cache' / 'huggingface'))
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
os.environ.setdefault('TIKTOKEN_CACHE_DIR', str(ROOT / '.model-cache' / 'tiktoken'))
MODEL = 'BAAI/bge-small-en-v1.5'
CACHE = str(ROOT / '.model-cache' / 'fastembed')
# Minimum reciprocal-rank-fusion score a fused hit must clear to be returned.
# Qdrant's RRF runs at k=2 (score = 1/(2+rank) per branch a hit lands in), so
# 0.001 requires a rank around the top 1000 of at least one branch.
RRF_SCORE_FLOOR = 0.001
# Each branch's candidate pool is bounded to top_k * this multiplier rather
# than left fully unbounded. This is the standard efficient hybrid-search
# pattern: bounded ANN/BM25 candidates feed RRF, then RRF's own limit does
# the final cut. 10x keeps recall effectively unbounded at this app's actual
# corpus sizes (tens to a few hundred chunks per document) while bounding
# retrieval work once a corpus is large enough for it to matter.
CANDIDATE_MULTIPLIER = 10


def emit(event):
    print(json.dumps(event, allow_nan=False), flush=True)


def progress(message):
    emit({'type': 'progress', 'message': message})


@lru_cache(maxsize=1)
def embedding_model():
    from fastembed import TextEmbedding
    return TextEmbedding(model_name=MODEL, cache_dir=CACHE, threads=4)


@lru_cache(maxsize=1)
def sparse_model():
    from fastembed import SparseTextEmbedding
    return SparseTextEmbedding(model_name='Qdrant/bm25', cache_dir=CACHE)

@lru_cache(maxsize=1)
def encoder_tokenizer():
    from transformers import AutoTokenizer
    return AutoTokenizer.from_pretrained(MODEL)

INDEX = None
INDEX_KEY = None
INDEX_CHUNKS = None

def clear_index(request=None):
    global INDEX, INDEX_KEY, INDEX_CHUNKS
    if INDEX is not None:
        INDEX.close()
    INDEX = None
    INDEX_KEY = None
    INDEX_CHUNKS = None
    return {}


def bounded_chunks(document, tokenizer):
    from docling.chunking import HybridChunker
    from docling_core.transforms.chunker.tokenizer.huggingface import HuggingFaceTokenizer
    import semchunk

    limit = tokenizer.model_max_length
    usable = limit - tokenizer.num_special_tokens_to_add(pair=False)
    chunker = HybridChunker(tokenizer=HuggingFaceTokenizer(tokenizer=tokenizer, max_tokens=usable), merge_peers=True)
    count = lambda text: len(tokenizer.encode(text, add_special_tokens=True, truncation=False))
    # Docling's repeated-table-header path can consume the whole token budget
    # before contextualize() adds section headings. Split only those overflows
    # with semchunk, the OSS text splitter Docling itself uses. Count the exact
    # final encoder input, including special tokens; never slice or truncate it.
    overflow_splitter = semchunk.chunkerify(count, chunk_size=limit, memoize=False)
    for chunk in chunker.chunk(dl_doc=document):
        contextualized = chunker.contextualize(chunk=chunk)
        parts = [contextualized] if count(contextualized) <= limit else overflow_splitter(contextualized)
        for part in parts:
            tokens = count(part)
            if tokens > limit:
                raise ValueError('The text splitter could not fit a passage within the embedding window. No text was truncated.')
            yield chunk, part, chunk.text if len(parts) == 1 else part, tokens, len(parts) > 1


def ingest(request):
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import DocumentStream, InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.chunking import HybridChunker
    from docling_core.transforms.chunker.tokenizer.huggingface import HuggingFaceTokenizer
    from transformers import AutoTokenizer

    name = Path(request['name']).name
    data = base64.b64decode(request['data'], validate=True)
    suffix = Path(name).suffix.lower()
    if suffix not in {'.pdf', '.docx', '.txt', '.md', '.markdown'}:
        raise ValueError('Choose PDF, DOCX, Markdown, or plain text.')
    if suffix in {'.txt', '.markdown'}:
        # Docling's Markdown backend handles plain text paragraphs as well.
        data.decode('utf-8')
        name = str(Path(name).with_suffix('.md'))
    progress('Docling: parsing document structure, tables and page references')
    options = PdfPipelineOptions()
    options.enable_remote_services = False
    options.artifacts_path = ROOT / '.model-cache' / 'docling'
    # Default local OCR and table structure recognition are retained.
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    result = converter.convert(DocumentStream(name=name, stream=io.BytesIO(data)), raises_on_error=True)
    if str(result.status.value) != 'success':
        raise ValueError('Docling did not convert the entire document successfully. No partial index was accepted.')
    progress('Docling HybridChunker: splitting by structure with the embedding tokenizer')
    tokenizer = encoder_tokenizer()
    limit = tokenizer.model_max_length
    if not isinstance(limit, int) or not 2 < limit < 1000000:
        raise ValueError('The embedding model does not declare a usable input window.')
    chunks = []
    offset = 0
    for index, (chunk, text, body, tokens, overflow_split) in enumerate(bounded_chunks(result.document, tokenizer)):
        pages = sorted({prov.page_no for item in chunk.meta.doc_items for prov in item.prov})
        refs = [item.self_ref for item in chunk.meta.doc_items]
        headings = chunk.meta.headings or []
        chunks.append({'index': index, 'text': text, 'body': body, 'start': offset, 'end': offset + len(body),
                       'page': pages[0] if pages else None, 'pageEnd': pages[-1] if pages else None,
                       'headings': headings, 'sourceRefs': refs, 'section': '\n'.join(headings),
                       'chunker': 'docling.HybridChunker', 'model': MODEL, 'tokenCount': tokens,
                       'modelTokenLimit': limit, 'overflowSplit': overflow_split})
        offset += len(body) + 1
    if not chunks:
        raise ValueError('Docling found no indexable text in this document.')
    progress(f'FastEmbed: embedding all {len(chunks)} contextualized chunks locally')
    model = embedding_model()
    for i, vector in enumerate(model.passage_embed((c['text'] for c in chunks), batch_size=32)):
        chunks[i]['vector'] = vector.tolist()
        if (i + 1) % 32 == 0 or i + 1 == len(chunks):
            progress(f'FastEmbed: embedded {i + 1} / {len(chunks)} chunks')
    return {'chunks': chunks, 'pages': len(result.document.pages), 'pipeline': 'Docling HybridChunker → FastEmbed BGE'}


def corpus_chunks(article):
    from llama_index.core import Document
    from llama_index.core.node_parser import SentenceSplitter
    from llama_index.core.schema import MetadataMode

    if not isinstance(article, dict) or any(k in article for k in ('query', 'answer', 'evidence_list')):
        raise ValueError('Load corpus articles, not questions or answer keys.')
    if any(not isinstance(article.get(k), str) or not article[k].strip() for k in ('title', 'body')):
        raise ValueError('Each corpus article needs a title and body.')
    metadata = {}
    for key in ('title', 'published_at', 'source'):
        value = article.get(key)
        if value is not None and not isinstance(value, str):
            raise ValueError(f'Invalid article {key}.')
        if value:
            metadata[key] = value
    # Match the explicit settings in MultiHop-RAG/simple_retrieval.py.
    splitter = SentenceSplitter(chunk_size=256, chunk_overlap=25)
    nodes = splitter.get_nodes_from_documents([Document(text=article['body'], metadata=metadata)])
    tokenizer = encoder_tokenizer()
    chunks = []
    previous_end = 0
    for index, node in enumerate(nodes):
        # LlamaIndex can report an earlier occurrence for repeated text. Each
        # successive chunk must advance through the source despite overlap.
        start = article['body'].find(node.text, max(0, previous_end - len(node.text) + 1))
        if start < 0:
            raise ValueError('Could not align a sentence chunk with its source article.')
        end = start + len(node.text)
        previous_end = end
        text = node.get_content(metadata_mode=MetadataMode.EMBED)
        tokens = len(tokenizer.encode(text, add_special_tokens=True, truncation=False))
        if tokens > tokenizer.model_max_length:
            raise ValueError('A sentence chunk exceeds the BGE embedding window. No text was truncated.')
        chunks.append({'index': index, 'text': text, 'body': node.text,
                       'start': start, 'end': end,
                       'page': None, 'pageEnd': None, 'headings': [article['title']],
                       'sourceRefs': [], 'section': article['title'],
                       'chunker': 'llama_index.SentenceSplitter', 'chunkSize': 256, 'chunkOverlap': 25,
                       'model': MODEL, 'tokenCount': tokens, 'modelTokenLimit': tokenizer.model_max_length})
    if not chunks:
        raise ValueError('No indexable text found in the article.')
    return chunks


def ingest_article(request):
    progress('LlamaIndex: splitting sentences with 256-token chunks and 25-token overlap')
    chunks = corpus_chunks(request.get('article'))
    for index, vector in enumerate(embedding_model().passage_embed((c['text'] for c in chunks), batch_size=32)):
        chunks[index]['vector'] = vector.tolist()
        if (index + 1) % 32 == 0 or index + 1 == len(chunks):
            progress(f'FastEmbed: embedded {index + 1} / {len(chunks)} sentence chunks')
    return {'chunks': chunks, 'pipeline': 'LlamaIndex SentenceSplitter 256/25 → FastEmbed BGE'}


def populate_index(client, chunks, sparse_vectors):
    from qdrant_client import models
    client.create_collection('passages', vectors_config={'dense': models.VectorParams(size=len(chunks[0]['vector']), distance=models.Distance.COSINE)},
                             sparse_vectors_config={'bm25': models.SparseVectorParams(modifier=models.Modifier.IDF)})
    for start in range(0, len(chunks), 128):
        client.upsert('passages', points=[models.PointStruct(id=i, vector={'dense': chunks[i]['vector'], 'bm25': sparse_vectors[i]})
                                         for i in range(start, min(start + 128, len(chunks)))])


def validate_retrieval_settings(top_k, semantic_threshold):
    if isinstance(top_k, bool) or not isinstance(top_k, int) or top_k < 1:
        raise ValueError('Retrieved candidates must be a positive whole number.')
    if (isinstance(semantic_threshold, bool) or not isinstance(semantic_threshold, (int, float))
            or not -1 <= semantic_threshold <= 1):
        raise ValueError('Minimum vector similarity must be a number between -1 and 1.')


def hybrid_search(chunks, query_vector, query_sparse, sparse_vectors, top_k, semantic_threshold, client=None):
    """Qdrant filters each search branch before reciprocal-rank fusion."""
    from qdrant_client import QdrantClient, models
    validate_retrieval_settings(top_k, semantic_threshold)
    if not chunks:
        return []
    owned = client is None
    client = client or QdrantClient(':memory:')
    try:
        if owned:
            populate_index(client, chunks, sparse_vectors)
        # Bound each branch to a candidate pool larger than top_k, then let
        # RRF fusion (not either branch alone) decide what survives to
        # top_k. A chunk that clears its branch threshold but ranks beyond
        # candidate_k within that branch is dropped before fusion; candidate_k
        # is kept far larger than top_k so that only pathologically large
        # qualifying sets are ever affected by this cap.
        candidate_k = min(top_k * CANDIDATE_MULTIPLIER, len(chunks))
        dense = models.Prefetch(query=query_vector, using='dense', limit=candidate_k, score_threshold=semantic_threshold)
        sparse = models.Prefetch(query=query_sparse, using='bm25', limit=candidate_k, score_threshold=1e-12)
        dense_hits = client.query_points('passages', query=query_vector, using='dense', limit=candidate_k, score_threshold=semantic_threshold).points
        sparse_hits = client.query_points('passages', query=query_sparse, using='bm25', limit=candidate_k, score_threshold=1e-12).points
        # BM25 has no meaningful absolute floor (any shared token scores positive
        # regardless of relevance), so filtering the branch input can't separate
        # signal from noise. Qdrant's RRF runs at k=2, i.e. score = 1/(2+rank)
        # per branch a hit appears in. RRF_SCORE_FLOOR requires a hit to have
        # ranked in roughly the top 1000 of at least one branch; empirically
        # this keeps every dense-relevant hit
        # while dropping most sparse-only noise that has no other qualifying signal.
        # top_k is the last word: Qdrant's own limit does the final cut, and
        # a threshold-filtered result is never backfilled up to top_k.
        fused = client.query_points('passages', prefetch=[dense, sparse], query=models.FusionQuery(fusion=models.Fusion.RRF),
                                     limit=top_k, score_threshold=RRF_SCORE_FLOOR).points
        dr = {p.id: (i + 1, p.score) for i, p in enumerate(dense_hits)}
        sr = {p.id: (i + 1, p.score) for i, p in enumerate(sparse_hits)}
        import numpy as np
        from sklearn.metrics.pairwise import cosine_similarity
        scores = cosine_similarity(np.asarray([c['vector'] for c in chunks]), [query_vector])[:, 0]
        results = []
        for hit in fused:
            i = int(hit.id)
            results.append({**chunks[i], 'similarity': float(scores[i]), 'bm25Score': sr.get(i, (None, 0))[1],
                            'hybridScore': hit.score, 'semanticRank': dr.get(i, (None, 0))[0],
                            'lexicalRank': sr.get(i, (None, 0))[0], 'retrievalReason': 'hybrid match'})
        return [{**c, 'retrievalRank': i + 1, 'label': f'C{i + 1}'} for i, c in enumerate(results)]
    finally:
        if owned:
            client.close()


def search(request):
    top_k = request.get('topK')
    semantic_threshold = request.get('semanticThreshold')
    validate_retrieval_settings(top_k, semantic_threshold)
    import math
    from qdrant_client import models
    global INDEX, INDEX_KEY, INDEX_CHUNKS
    chunks = request.get('chunks')
    if chunks is None:
        if INDEX is None or request.get('corpusKey') != INDEX_KEY:
            return {'needsIndex': True}
        chunks = INDEX_CHUNKS
    if not chunks:
        return {'candidates': []}
    if any(c.get('model') != MODEL or len(c['vector']) != 384 or not all(math.isfinite(v) for v in c['vector']) for c in chunks):
        raise ValueError('Re-upload documents to use the current Docling and BGE pipeline.')
    timings = {}
    started = time.perf_counter()
    progress('Embedding question')
    model = embedding_model()
    # BGE retrieval guidance uses a query instruction; passages are unprefixed.
    question = request['question']
    instructed = 'Represent this sentence for searching relevant passages: ' + question
    from transformers import AutoTokenizer
    if len(encoder_tokenizer().encode(instructed)) > 512:
        raise ValueError('The question exceeds the embedding model input window. Shorten the question; it was not truncated.')
    vector = next(model.query_embed(instructed)).tolist()
    timings['Question embedding'] = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    bm25 = sparse_model()
    key = request.get('corpusKey') or hashlib.sha256(json.dumps(chunks, sort_keys=True).encode()).hexdigest()
    reused = INDEX is not None and INDEX_KEY == key
    if not reused:
        progress('Building in-memory index for the loaded documents')
        from qdrant_client import QdrantClient
        clear_index()
        candidate_index = QdrantClient(':memory:')
        try:
            sparse_vectors = [models.SparseVector(indices=v.indices.tolist(), values=v.values.tolist()) for v in bm25.passage_embed((c['text'] for c in chunks))]
            populate_index(candidate_index, chunks, sparse_vectors)
        except Exception:
            candidate_index.close()
            raise
        INDEX = candidate_index
        INDEX_KEY = key
        INDEX_CHUNKS = chunks
    timings['Index reuse check' if reused else 'Index build'] = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    q = next(bm25.query_embed(question))
    sparse_query = models.SparseVector(indices=q.indices.tolist(), values=q.values.tolist())
    progress(f'Qdrant in memory: vector similarity above {semantic_threshold} or positive BM25; at most {top_k} candidates')
    candidates = hybrid_search(chunks, vector, sparse_query, None, top_k, semantic_threshold, client=INDEX)
    timings['Hybrid search'] = (time.perf_counter() - started) * 1000
    return {'candidates': [{k: v for k, v in c.items() if k != 'vector'} for c in candidates], 'timings': timings, 'indexReused': reused}


def project(request):
    import numpy as np
    from sklearn.decomposition import PCA
    vectors = np.asarray(request['vectors'], dtype=np.float32)
    if len(vectors) <= 1:
        return {'coordinates': [[0, 0] for _ in vectors]}
    if np.all(vectors == vectors[0]):
        return {'coordinates': [[0, 0] for _ in vectors]}
    coordinates = PCA(n_components=2, svd_solver='randomized', random_state=0).fit_transform(vectors)
    return {'coordinates': coordinates.tolist()}


if __name__ == '__main__':
    from contextlib import redirect_stdout
    protocol_out = sys.stdout
    def emit(event):
        protocol_out.write(json.dumps(event, allow_nan=False) + '\n')
        protocol_out.flush()
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with redirect_stdout(io.StringIO()):
                result = {'ingest': ingest, 'ingest-article': ingest_article, 'search': search, 'project': project, 'clear': clear_index}[request['mode']](request)
            emit({'type': 'done', **result})
        except Exception as exc:
            safe = str(exc) if type(exc) is ValueError else f'Local document pipeline failed ({type(exc).__name__}).'
            emit({'type': 'error', 'message': safe})
        finally:
            request = None
            result = None
            line = None
