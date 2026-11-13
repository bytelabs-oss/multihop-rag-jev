'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, FileText, Network, Search, X, Plus, ArrowUpRight, LoaderCircle, List, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { COLORS, type Chunk, type Doc, docBody } from '../lib/documents';
import { cachePayload, validateCache, saveDocument, savedDocument, savedDocuments, clearSavedDocuments, articleId, savedProjection, saveProjection } from '../lib/cache.mjs';
import { parseCorpus, selectArticles } from '../lib/corpus.mjs';
import { demoSources } from '../lib/demo';
import { type ComparisonMode, type ModelCall, type Run, type Settings } from '../lib/experiment';
import { localDocuments, encodeFile } from '../lib/local-documents';
import { streamExperiment } from '../lib/stream-experiment';
import { ChunkMap } from './chunk-map';
import { CorpusDialog } from './corpus-dialog';
import { ChatPanel } from './experiment-panels';
import { EvidenceSidebar, RunDetails } from './run-details';

export default function Home() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [sample, setSample] = useState(false);
  const [originals, setOriginals] = useState(() => new Map<string, string>());
  const originalsRef = useRef(originals);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'map' | 'list' | 'details'>('map');
  const [dragging, setDragging] = useState(false);
  const cacheInput = useRef<HTMLInputElement>(null);
  const [showCorpus, setShowCorpus] = useState(false);
  const [cacheMessage, setCacheMessage] = useState('');
  const [listPage, setListPage] = useState(0);
  const [showForget, setShowForget] = useState(false);
  const [loadingCorpus, setLoadingCorpus] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const busy = !!status || asking;

  useEffect(() => {
    savedDocuments()
      .then((items: Doc[]) => setCacheMessage(items.length ? `${items.length} documents saved locally` : 'No saved embeddings'))
      .catch(() => setCacheMessage('Browser cache unavailable'));
  }, []);

  const inspectedRun = runs.find(run => run.id === activeRun);

  useEffect(() => {
    fetch('/api/experiment')
      .then(response => response.json())
      .then(data => setConfigured((data as { configured: boolean }).configured))
      .catch(() => setConfigured(false));
    const select = (event: Event) => setSelected((event as CustomEvent<string>).detail);
    window.addEventListener('atlas-select-chunk', select);
    return () => {
      requestRef.current?.abort();
      window.removeEventListener('atlas-select-chunk', select);
    };
  }, []);

  useEffect(() => () => {
    for (const url of originalsRef.current.values()) URL.revokeObjectURL(url);
  }, []);

  async function ask(question: string, settings: Settings, choice: ComparisonMode | 'all', referenceAnswer?: string) {
    if (busy || requestRef.current || !docs.length) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setAsking(true);
    setError('');
    const groupId = crypto.randomUUID();
    const modes: ComparisonMode[] = choice === 'all' ? ['hybrid', 'jev', 'keyword', 'keyword-jev'] : [choice];
    const next: Run[] = modes.map(currentMode => ({
      id: crypto.randomUUID(),
      groupId,
      mode: currentMode,
      question,
      referenceAnswer,
      settings,
      candidates: [],
      ranked: [],
      phase: currentMode === 'keyword' || currentMode === 'keyword-jev' ? 'searching' : 'embedding',
    }));
    setActiveRun(next[0].id);
    setRuns(previous => [...previous, ...next]);
    const chunks = docs.flatMap(doc => doc.chunks.map(chunk => ({ ...chunk, docId: doc.id, docName: doc.name })));
    const documents = docs.map(doc => ({ id: doc.id, name: doc.name, body: docBody(doc) }));
    const started = performance.now();
    const retrieval = modes.some(currentMode => currentMode !== 'keyword' && currentMode !== 'keyword-jev')
      ? localDocuments({ mode: 'search', corpusKey: docs.map(doc => doc.id).join(','), question, topK: settings.topK, semanticThreshold: settings.semanticThreshold, chunks }, () => {}, controller.signal).then(result => ({ ...result, ms: performance.now() - started }))
      : null;

    async function execute(run: Run, source = retrieval) {
      const id = run.id;
      const update = (patch: Partial<Run>) => setRuns(previous => previous.map(item => item.id === id ? { ...item, ...patch } : item));
      const recordedCalls: ModelCall[] = [];
      try {
        let candidates;
        if (run.mode !== 'keyword' && run.mode !== 'keyword-jev') {
          const result = await source!;
          candidates = result.candidates;
          update({ candidates, phase: 'retrieved', retrievalMs: result.ms, retrievalTimings: result.timings });
        }
        // The streaming layer emits a heterogeneous event union from JS modules.
        // Keeping it loose here avoids a large local redefinition of that union.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const apply = (event: any) => {
          if (event.type === 'model-call') {
            const call = { ...event.call, id: `${id}-${event.call.id}` } as ModelCall;
            const index = recordedCalls.findIndex(item => item.id === call.id);
            if (index < 0) recordedCalls.push(call);
            else recordedCalls[index] = call;
            update({ calls: [...(run.calls || []), ...recordedCalls] });
          }
          if (event.type === 'searching') update({ phase: 'searching', progress: event.progress });
          if (event.type === 'keyword-attempt') update({ progress: `Searched /${event.pattern}/i · ${event.matches} match${event.matches === 1 ? '' : 'es'}` });
          if (event.type === 'keyword-blocks') update({ phase: 'searching', candidates: event.blocks.map((block: { id: string; docId: string; docName: string; label: string; start: number; end: number; text: string; rank: number }) => ({ id: block.id, docId: block.docId, docName: block.docName, label: block.label, index: 0, start: block.start, end: block.end, page: null, text: block.text, similarity: 0, bm25Score: 0, hybridScore: 0, semanticRank: null, lexicalRank: null, retrievalRank: block.rank, retrievalReason: 'keyword' })) });
          if (event.type === 'ranking') update({ phase: 'ranking', questions: event.questions });
          if (event.type === 'relevance-progress') update({ progress: `JEV relevance: ${event.completed} / ${event.total} chunks` });
          if (event.type === 'selection-step') setRuns(previous => previous.map(item => item.id === id ? { ...item, ranked: item.ranked.map(candidate => candidate.id === event.decision.id ? event.decision : candidate), progress: event.progress, selection: event.check ? [...(item.selection || []), event.check] : item.selection } : item));
          if (event.type === 'ranked') update({ phase: 'selecting', progress: undefined, ranked: event.ranked, jevAnswers: event.jevAnswers, jevUsage: event.jevUsage, jevMs: event.jevMs });
          if (event.type === 'selecting') update({ phase: 'selecting', progress: event.progress });
          if (event.type === 'selected') update({ ranked: event.ranked, context: event.context, selection: event.selection, jevMs: event.jevMs, searchTerms: event.searchTerms, retrievalMs: event.retrievalMs });
          if (event.type === 'answer-delta') setRuns(previous => previous.map(item => item.id === id ? { ...item, answer: (item.answer || '') + event.delta, phase: 'answering' } : item));
          if (event.type === 'answering') update({ phase: 'answering', progress: undefined });
          if (event.type === 'answer') update({ elapsedMs: performance.now() - started, phase: 'done', progress: undefined, answer: event.answer, llmUsage: event.llmUsage, llmMs: event.llmMs });
          if (event.type === 'error') update({ phase: 'error', error: event.error });
        };
        const terminal = await streamExperiment({ mode: run.mode, question, settings, candidates, documents: run.mode === 'keyword' || run.mode === 'keyword-jev' ? documents : undefined }, apply, controller.signal);
        if (run.mode === 'jev' && !run.retryOf && settings.retryOnEmpty && terminal.skipped) {
          const retry: Run = { id: crypto.randomUUID(), groupId, mode: 'jev', retryOf: id, question, settings, candidates: [], ranked: [], phase: 'searching', progress: 'Rewriting the search query', calls: [...recordedCalls] };
          setRuns(previous => [...previous, retry]);
          setActiveRun(retry.id);
          const updateRetry = (patch: Partial<Run>) => setRuns(previous => previous.map(item => item.id === retry.id ? { ...item, ...patch } : item));
          let retryCalls = retry.calls || [];
          try {
            const rewrite = await streamExperiment({ mode: 'rewrite', question, settings, candidates: [] }, event => {
              if (event.type === 'model-call') {
                const call = { ...event.call, id: `rewrite-${retry.id}-${event.call.id}` };
                retryCalls = [...retryCalls.filter(item => item.id !== call.id), call];
                updateRetry({ calls: retryCalls });
              }
            }, controller.signal);
            updateRetry({ retrievalQuery: rewrite.query, phase: 'embedding', progress: 'Retrieving with the rewritten query' });
            const retrievalStart = performance.now();
            const result = await localDocuments({ mode: 'search', corpusKey: docs.map(doc => doc.id).join(','), question: rewrite.query, topK: settings.topK, semanticThreshold: settings.semanticThreshold, chunks }, () => {}, controller.signal);
            await execute({ ...retry, calls: retryCalls, retrievalQuery: rewrite.query }, Promise.resolve({ ...result, ms: performance.now() - retrievalStart }));
          } catch (cause) {
            updateRetry({ phase: controller.signal.aborted ? 'cancelled' : 'error', error: (cause as Error).message, elapsedMs: performance.now() - started, calls: retryCalls.map(call => call.status === 'running' ? { ...call, status: controller.signal.aborted ? 'cancelled' : 'failed' } : call) });
          }
        }
      } catch (cause) {
        update(controller.signal.aborted ? { phase: 'cancelled' } : { phase: 'error', error: (cause as Error).message });
      } finally {
        setRuns(previous => previous.map(item => item.id === id ? { ...item, elapsedMs: item.elapsedMs ?? performance.now() - started, calls: item.calls?.map(call => call.status === 'running' ? { ...call, status: controller.signal.aborted ? 'cancelled' : 'failed' } : call) } : item));
      }
    }

    try {
      await Promise.all(next.map(run => execute(run)));
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      setAsking(false);
      setStatus('');
    }
  }

  async function remember(doc: Doc) {
    try {
      await saveDocument(doc);
    } catch {
      setCacheMessage('Cache save failed. Export your embeddings before leaving.');
      throw new Error('Browser cache is full or unavailable. Export your embeddings before leaving.');
    }
  }

  async function restoreCache(file?: File) {
    if (busy || requestRef.current) return;
    setStatus(file ? 'Importing embedding cache' : 'Restoring saved embeddings');
    setError('');
    try {
      const restored: Doc[] = file ? validateCache(JSON.parse(await file.text())) : await savedDocuments();
      if (!restored.length) throw new Error('No saved embeddings found.');
      if (file) for (const doc of restored) await remember(doc);
      setDocs(restored);
      setSample(false);
      setRuns([]);
      setActiveRun(null);
      setSelected(null);
      setFilter(null);
      setQuery('');
      setCacheMessage(`${restored.length} documents restored without re-embedding`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setStatus('');
      if (cacheInput.current) cacheInput.current.value = '';
    }
  }

  async function exportCache() {
    try {
      const items = docs.length ? docs : await savedDocuments();
      if (!items.length) throw new Error('No embeddings to export.');
      const blob = new Blob([JSON.stringify(cachePayload(items))], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'atlas-embeddings.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function loadCorpus(count: number, selection: 'first' | 'random') {
    if (busy || requestRef.current) return;
    setShowCorpus(false);
    const controller = new AbortController();
    requestRef.current = controller;
    setLoadingCorpus(true);
    setError('');
    setStatus('Reading bundled MultiHop-RAG corpus');
    let completed = 0;
    let reused = 0;
    try {
      const response = await fetch('/datasets/multihop-rag/corpus.json', { signal: controller.signal });
      if (!response.ok) throw new Error('The bundled corpus could not be loaded.');
      const articles = selectArticles(parseCorpus(await response.json()), count, selection);
      const next: Doc[] = [];
      for (let index = 0; index < articles.length; index++) {
        if (controller.signal.aborted) throw new Error('Corpus import cancelled.');
        const article = articles[index];
        const id = await articleId(article);
        const cached = await savedDocument(id) as Doc | undefined;
        if (cached) {
          validateCache(cachePayload([cached]));
          next.push(cached);
          reused++;
          completed++;
          continue;
        }
        const prefix = `Article ${index + 1} / ${articles.length}`;
        setStatus(`${prefix}: ${article.title}`);
        const { chunks } = await localDocuments({ mode: 'ingest-article', article }, message => setStatus(`${prefix} · ${message}`), controller.signal);
        const doc: Doc = {
          id,
          name: article.title.slice(0, 250),
          size: new Blob([article.body]).size,
          count: chunks.length,
          created: new Date().toISOString(),
          chunks: chunks.map((chunk: Chunk, chunkIndex: number) => ({ ...chunk, id: `${id}:${chunkIndex}` })),
          body: article.body,
        };
        await remember(doc);
        next.push(doc);
        completed++;
      }
      if (controller.signal.aborted) throw new Error('Corpus import cancelled.');
      setDocs(previous => sample ? next : [...previous.filter(doc => !doc.id.startsWith('corpus-')), ...next]);
      setSample(false);
      setRuns([]);
      setActiveRun(null);
      setSelected(next[0]?.chunks[0]?.id ?? null);
      setFilter(null);
      setQuery('');
      setCacheMessage(`${completed} articles loaded · ${reused} reused from cache`);
    } catch (cause) {
      setError(`${controller.signal.aborted ? 'Corpus import cancelled.' : (cause as Error).message} ${completed} processed articles are saved locally. Use Restore saved or load again to resume.`);
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      setLoadingCorpus(false);
      setStatus('');
    }
  }

  async function upload(files: FileList | null) {
    if (!files?.length || busy || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setRuns([]);
    setActiveRun(null);
    setError('');
    if (sample) {
      setDocs([]);
      setSample(false);
      setSelected(null);
      setFilter(null);
    }
    let success = 0;
    try {
      for (const file of Array.from(files)) {
        setStatus(`Reading ${file.name}`);
        const { chunks } = await localDocuments({ mode: 'ingest', name: file.name, data: await encodeFile(file) }, setStatus, controller.signal);
        const id = crypto.randomUUID();
        const data: Doc = { id, name: file.name, size: file.size, count: chunks.length, created: new Date().toISOString(), chunks: chunks.map((chunk: Chunk, index: number) => ({ ...chunk, id: `${id}:${index}` })) };
        const url = URL.createObjectURL(file);
        setOriginals(previous => {
          const next = new Map(previous);
          next.set(id, url);
          originalsRef.current = next;
          return next;
        });
        setDocs(previous => [...previous, data]);
        await remember(data);
        setCacheMessage('Uploaded document embeddings saved locally');
        setSelected(data.chunks[0].id);
        setFilter(null);
        success++;
      }
    } catch (cause) {
      setError((success ? `${success} document(s) added. ` : '') + (cause as Error).message);
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      setStatus('');
      if (input.current) input.current.value = '';
    }
  }

  async function exploreSample() {
    if (busy || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setRuns([]);
    setActiveRun(null);
    setError('');
    setStatus('Preparing sample documents');
    try {
      const next: Doc[] = [];
      for (const draft of demoSources()) {
        const file = new File([draft.source.text], draft.name.replace(/\.[^.]+$/, '.md'));
        const { chunks } = await localDocuments({ mode: 'ingest', name: file.name, data: await encodeFile(file) }, setStatus, controller.signal);
        next.push({ id: draft.id, name: draft.name, size: draft.source.text.length, count: chunks.length, created: new Date().toISOString(), chunks: chunks.map((chunk: Chunk, index: number) => ({ ...chunk, id: `${draft.id}:${index}` })) });
      }
      setDocs(next);
      setSample(true);
      setSelected(next[0]?.chunks[0]?.id ?? null);
      setFilter(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      setStatus('');
    }
  }

  const allNodes = useMemo(() => docs.flatMap((doc, index) => doc.chunks.map(chunk => ({ ...chunk, docId: doc.id, docName: doc.name, color: COLORS[index % COLORS.length] }))), [docs]);
  const [projection, setProjection] = useState<{ source: typeof allNodes; coordinates: number[][] } | null>(null);

  useEffect(() => {
    if (!allNodes.length) {
      return;
    }
    const controller = new AbortController();
    const key = docs.map(doc => `${doc.id}:${doc.chunks.length}`).join(',');
    (async () => {
      let coordinates = await savedProjection(key).catch(() => undefined) as number[][] | undefined;
      if (!coordinates || coordinates.length !== allNodes.length) {
        const result = await localDocuments({ mode: 'project', vectors: allNodes.map(chunk => chunk.vector) }, () => {}, controller.signal);
        coordinates = result.coordinates;
        await saveProjection(key, coordinates).catch(() => {});
      }
      if (!controller.signal.aborted) setProjection({ source: allNodes, coordinates: coordinates! });
    })().catch(cause => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    return () => controller.abort();
  }, [allNodes, docs]);

  const nodes = useMemo(() => {
    const coords = projection?.source === allNodes ? projection.coordinates : allNodes.map(() => [0, 0]);
    let bound = 0.1;
    for (const coordinate of coords) bound = Math.max(bound, Math.abs(coordinate[0]), Math.abs(coordinate[1]));
    return allNodes.map((chunk, index) => ({ ...chunk, x: coords[index][0] / bound * 290, y: coords[index][1] / bound * 220 }));
  }, [allNodes, projection]);
  const current = nodes.find(node => node.id === selected);
  const visible = useMemo(() => nodes.filter(node => (!filter || node.docId === filter) && (!query || node.text.toLowerCase().includes(query.toLowerCase()) || node.docName.toLowerCase().includes(query.toLowerCase()))), [nodes, filter, query]);
  const visibleIds = useMemo(() => new Set(visible.map(node => node.id)), [visible]);
  const candidateIds = useMemo(() => new Set(inspectedRun?.candidates.map(candidate => candidate.id)), [inspectedRun?.candidates]);
  const keptIds = useMemo(() => new Set(inspectedRun?.ranked.filter(candidate => candidate.kept).map(candidate => candidate.id)), [inspectedRun?.ranked]);

  function remove(id: string) {
    localDocuments({ mode: 'clear' }, () => {}).catch(() => {});
    setRuns([]);
    setActiveRun(null);
    const url = originalsRef.current.get(id);
    if (url) URL.revokeObjectURL(url);
    setOriginals(previous => {
      const next = new Map(previous);
      next.delete(id);
      originalsRef.current = next;
      return next;
    });
    setDocs(previous => previous.filter(doc => doc.id !== id));
    if (current?.docId === id) setSelected(null);
    if (filter === id) setFilter(null);
  }

  const currentListPage = Math.min(listPage, Math.max(0, Math.ceil(visible.length / 50) - 1));

  return (
    <main
      className="app"
      onDragOver={event => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Element)) setDragging(false);
      }}
      onDrop={event => {
        event.preventDefault();
        setDragging(false);
        upload(event.dataTransfer.files);
      }}
    >
      <Input ref={cacheInput} type="file" accept=".json,application/json" hidden onChange={event => { if (event.target.files?.[0]) restoreCache(event.target.files[0]); }} />
      <Input ref={input} type="file" accept=".pdf,.docx,.txt,.md,.markdown" multiple hidden onChange={event => upload(event.target.files)} />
      <header className="topbar">
        <Link href="/" className="brand" aria-label="Atlas home">
          <Network size={25} />
          <span>atlas<span className="brand-period">.</span></span>
        </Link>
        <span className="divider" />
        <span className="workspace">JEV retrieval experiment</span>
        <span className="header-right">
          <a className="faq-link" href="/benchmark" target="_blank" rel="noopener noreferrer" aria-label="Full benchmark (opens in a new tab)">Benchmark</a>
          <a className="faq-link" href="/faq" target="_blank" rel="noopener noreferrer" aria-label="FAQ (opens in a new tab)">FAQ</a>
          <span className="private-label"><span className="lock-dot" />Local session</span>
          <Button type="button" variant="outline" className="upload" disabled={busy} title="Load bundled MultiHop-RAG articles. Choose a count and reuse saved embeddings." aria-haspopup="dialog" onClick={() => setShowCorpus(true)}>
            Load MultiHop-RAG
          </Button>
          <Button type="button" className="upload" disabled={busy} onClick={() => input.current?.click()}>
            <Plus size={17} /> Upload documents
          </Button>
        </span>
      </header>
      <div className="cache-toolbar">
        <span>{cacheMessage}</span>
        <Button type="button" variant="link" className="h-auto p-0" disabled={busy} onClick={() => restoreCache()}>Restore saved</Button>
        <Button type="button" variant="link" className="h-auto p-0" disabled={busy} onClick={exportCache}>Export cache</Button>
        <Button type="button" variant="link" className="h-auto p-0" disabled={busy} onClick={() => cacheInput.current?.click()}>Import cache</Button>
        <Button type="button" variant="link" className="h-auto p-0" disabled={busy} onClick={() => setShowForget(true)}>Forget saved</Button>
      </div>
      <Group className="shell resizable-shell" orientation="horizontal" id="atlas-workspace">
        <Panel id="sources" defaultSize="25%" minSize={230}>
          <EvidenceSidebar docs={docs} run={inspectedRun} selected={selected} current={current} filter={filter} busy={busy} originals={originals} onFilter={setFilter} onRemove={remove} onSelect={id => { setSelected(id); setFilter(null); setQuery(''); setListPage(0); }} />
        </Panel>
        <Separator className="panel-resizer" aria-label="Resize document sidebar" />
        <Panel id="workspace" minSize={330}>
          <section className="explorer">
            <div className="explorer-heading">
              <div>
                <div className="title-line">
                  <Button type="button" variant="ghost" size="icon" className="mobile-docs icon-button" aria-label="Show documents">
                    <FileText size={20} />
                  </Button>
                  <h1>Chunk space</h1>
                  {sample && <span className="sample-badge">Sample</span>}
                </div>
                <p>{nodes.length ? `${nodes.length} chunks · ${docs.length} documents` : ''}</p>
              </div>
              <div className="view-switch" aria-label="View">
                <Button type="button" variant="ghost" size="sm" aria-label="Map view" aria-pressed={mode === 'map'} className={mode === 'map' ? 'chosen' : ''} onClick={() => setMode('map')}>
                  <Network size={17} />
                  <span>Map</span>
                </Button>
                <Button type="button" variant="ghost" size="sm" aria-label="List view" aria-pressed={mode === 'list'} className={mode === 'list' ? 'chosen' : ''} onClick={() => setMode('list')}>
                  <List size={17} />
                  <span>List</span>
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={!inspectedRun} aria-pressed={mode === 'details'} className={mode === 'details' ? 'chosen' : ''} onClick={() => setMode('details')}>
                  Run details
                </Button>
              </div>
            </div>
            {mode !== 'details' && (
              <div className="map-toolbar">
                <label className="search">
                  <Search size={16} />
                  <Input aria-label="Filter map and list by text or filename" title="Filters the map and list by matching text or filename. Use chat for hybrid retrieval." placeholder="Filter text or filename…" value={query} onChange={event => { setQuery(event.target.value); setListPage(0); }} className="h-auto border-0 bg-transparent p-0 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent" />
                  {query && <Button type="button" variant="ghost" size="icon-xs" aria-label="Clear search" onClick={() => { setQuery(''); setListPage(0); }}><X size={15} /></Button>}
                </label>
                <div className="method"><span className="method-dot" />BGE · Qdrant</div>
              </div>
            )}
            {error && <div className="error" role="alert"><span>{error}</span><Button type="button" variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></Button></div>}
            {status && <div className="progress" role="status"><LoaderCircle className="spin" size={17} /><span>{status}</span>{loadingCorpus && <Button type="button" variant="link" className="text-action h-auto p-0" onClick={() => requestRef.current?.abort()}>Cancel import</Button>}</div>}
            {mode === 'details' ? (
              <RunDetails key={inspectedRun?.id} run={inspectedRun} runs={runs} onSelectRun={setActiveRun} onSelectChunk={id => { setSelected(id); setFilter(null); setQuery(''); }} />
            ) : (
              <div className="map-area">
                {allNodes.length > 0 && projection?.source !== allNodes && <div className="progress">Projecting all chunks with scikit-learn PCA…</div>}
                {!nodes.length ? (
                  <div className="empty-state">
                    <div className="empty-symbol"><Network size={44} strokeWidth={1} /></div>
                    <Button type="button" disabled={busy} onClick={() => input.current?.click()}>
                      <Upload size={17} /> Upload documents
                    </Button>
                    <Button type="button" variant="link" className="sample-link h-auto p-0" disabled={busy} onClick={exploreSample}>
                      Load sample documents <ArrowUpRight size={15} />
                    </Button>
                    <small>PDF, DOCX, Markdown, TXT</small>
                  </div>
                ) : mode === 'map' ? (
                  <>
                    <ChunkMap nodes={nodes} visible={visibleIds} selected={selected} candidates={candidateIds} kept={keptIds} onSelect={setSelected} />
                    {!visible.length && <div className="no-matches">No passages match: {query}</div>}
                  </>
                ) : (
                  <div className="chunk-list">
                    {visible.slice(currentListPage * 50, (currentListPage + 1) * 50).map(node => (
                      <Button key={node.id} type="button" variant="ghost" className={`chunk-row h-auto w-full justify-start ${selected === node.id ? 'selected' : ''}`} onClick={() => setSelected(node.id)}>
                        <span className="chunk-source"><span style={{ background: node.color }} />{node.docName} · Chunk {node.index + 1}</span>
                        <p>{node.text}</p>
                        <ArrowUpRight size={16} />
                      </Button>
                    ))}
                    {visible.length > 50 && <div className="list-pagination"><Button type="button" variant="outline" size="sm" disabled={!currentListPage} onClick={() => setListPage(value => value - 1)}>Previous</Button><span>Page {currentListPage + 1} / {Math.ceil(visible.length / 50)}</span><Button type="button" variant="outline" size="sm" disabled={(currentListPage + 1) * 50 >= visible.length} onClick={() => setListPage(value => value + 1)}>Next</Button></div>}
                    {!visible.length && <p className="quiet">No matching passages. Try a different word.</p>}
                  </div>
                )}
              </div>
            )}
            <footer className="map-footer"><span><span className="count-dot" />{visible.length} {visible.length === 1 ? 'chunk' : 'chunks'} visible</span></footer>
          </section>
        </Panel>
        <Separator className="panel-resizer" aria-label="Resize chat sidebar" />
        <Panel id="chat" defaultSize="30%" minSize={300}>
          <ChatPanel runs={runs} activeId={activeRun} onSelect={id => { setActiveRun(id); setMode('details'); }} onAsk={ask} onStop={() => requestRef.current?.abort()} busy={busy} hasChunks={!!nodes.length} configured={configured} cancellable={asking} documents={docs} />
        </Panel>
      </Group>
      {showCorpus && <CorpusDialog onClose={() => setShowCorpus(false)} onLoad={loadCorpus} />}
      <Dialog open={showForget} onOpenChange={setShowForget}>
        <DialogContent className="confirm gap-0 sm:max-w-none" showCloseButton={false}>
          <DialogTitle>Forget saved embeddings?</DialogTitle>
          <p>This deletes the browser cache. Documents currently loaded in the app stay available until you leave.</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowForget(false)}>Cancel</Button>
            <Button type="button" onClick={async () => { try { await clearSavedDocuments(); setCacheMessage('Saved embeddings deleted'); setShowForget(false); } catch (cause) { setError((cause as Error).message); } }}>Forget saved</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {sample && <div className="sample-bar"><span>Exploring an example collection. These are sample documents.</span><Button type="button" variant="link" className="h-auto p-0" disabled={busy} onClick={() => { setSample(false); setSelected(null); setFilter(null); setDocs([]); setRuns([]); setActiveRun(null); }}> <RotateCcw size={14} /> Back to my documents</Button></div>}
      {dragging && <div className="drag-overlay"><Upload size={44} /><h2>Drop documents into your space</h2><p>PDF, DOCX, Markdown, or text</p></div>}
    </main>
  );
}
