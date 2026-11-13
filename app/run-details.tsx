'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { FileText, Trash2, Download } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Doc, Chunk } from '../lib/documents';
import { runLabel, type ModelCall, type Run } from '../lib/experiment';
import { defaultRates, estimateCost, formatCost } from '../lib/cost.mjs';
import { ComparisonDialog } from './comparison-dialog';
import { PipelinePanel } from './experiment-panels';
import { sumUsage, tokenUsage } from '../lib/usage.mjs';

type Passage = Pick<Chunk, 'id' | 'index' | 'text'> & { docName: string };
type EvidenceSubset = 'all' | 'kept' | 'dropped';

export const EvidenceSidebar = memo(function EvidenceSidebar({
  docs,
  run,
  selected,
  current,
  filter,
  busy,
  originals,
  onFilter,
  onRemove,
  onSelect,
  showDocuments = true,
}: {
  docs: Doc[];
  run?: Run;
  selected: string | null;
  current?: Passage;
  filter: string | null;
  busy: boolean;
  originals: Map<string, string>;
  onFilter: (id: string | null) => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
  showDocuments?: boolean;
}) {
  const [subsetChoice, setSubsetChoice] = useState<{ runId?: string; value?: EvidenceSubset }>({});
  const [documentPage, setDocumentPage] = useState(0);
  const sidebar = useRef<HTMLElement>(null);

  useEffect(() => {
    sidebar.current?.scrollTo({ top: 0 });
  }, [run?.id]);

  const subset = subsetChoice.runId === run?.id ? subsetChoice.value ?? 'all' : 'all';
  const page = Math.min(documentPage, Math.max(0, Math.ceil(docs.length / 30) - 1));
  const decisions = new Map(run?.ranked.map(result => [result.id, result]));
  const all = run?.candidates ?? [];
  const groups = {
    all,
    kept: all.filter(candidate => decisions.get(candidate.id)?.kept),
    dropped: all.filter(candidate => {
      const decision = decisions.get(candidate.id);
      return decision && !decision.kept && decision.reason !== 'Awaiting selection';
    }),
  };
  const candidates = groups[subset];
  const emptyMessage = all.length ? 'No chunks in this group.'
    : run?.retrievalMs !== undefined || run?.phase === 'done' ? 'No chunks matched this retrieval.'
    : run?.phase === 'cancelled' ? 'The run stopped before retrieval completed.'
    : run?.phase === 'error' ? 'Retrieval did not finish. See the run error.'
    : 'Retrieving chunks...';

  return <aside ref={sidebar} className="evidence-sidebar">
    {showDocuments && <section className="uploaded-docs">
      <header><h2>Documents</h2><span>{docs.length}</span></header>
      <div key={page} className="uploaded-document-list">
        {!docs.length && <p className="quiet">No documents uploaded.</p>}
        {docs.slice(page * 30, (page + 1) * 30).map(doc => <div className={`uploaded-doc ${filter === doc.id ? 'active' : ''}`} key={doc.id}>
          <Button type="button" variant="ghost" className="uploaded-doc-select h-auto flex-1 justify-start p-0" aria-pressed={filter === doc.id} onClick={() => onFilter(filter === doc.id ? null : doc.id)}>
            <FileText size={15} /><span>{doc.name}<small>{doc.chunks.length} chunks</small></span>
          </Button>
          {originals.has(doc.id) && <a href={originals.get(doc.id)} download={doc.name} aria-label={`Download ${doc.name}`}><Download size={14} /></a>}
          <Button type="button" variant="ghost" size="icon-xs" disabled={busy} aria-label={`Remove ${doc.name}`} onClick={() => onRemove(doc.id)}><Trash2 size={14} /></Button>
        </div>)}
      </div>
      {docs.length > 30 && <div className="list-pagination">
        <Button type="button" variant="outline" size="sm" disabled={!page} onClick={() => setDocumentPage(page - 1)}>Previous</Button>
        <span>{page + 1} / {Math.ceil(docs.length / 30)}</span>
        <Button type="button" variant="outline" size="sm" disabled={(page + 1) * 30 >= docs.length} onClick={() => setDocumentPage(page + 1)}>Next</Button>
      </div>}
      {filter && <Button type="button" variant="link" className="text-action h-auto p-0" onClick={() => onFilter(null)}>Clear document filter</Button>}
    </section>}
    <section className="retrieved-sidebar">
      <header><h2>Retrieved chunks</h2><span>{all.length}</span></header>
      {run ? <>
        <p className="sidebar-question" title={run.question}>{runLabel(run)} · {run.question}</p>
        <div className="chunk-subsets" aria-label="Evidence group">
          {(['all', 'kept', 'dropped'] as const).map(value => <Button
            key={value}
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={subset === value}
            onClick={() => setSubsetChoice({ runId: run.id, value })}
          >
            {value === 'all' ? 'Retrieved' : value === 'kept' ? 'Kept' : 'Dropped'} <span>{groups[value].length}</span>
          </Button>)}
        </div>
        {!candidates.length && <p className="quiet" role="status">{emptyMessage}</p>}
        {candidates.map(candidate => {
          const result = decisions.get(candidate.id);
          return <div key={candidate.id} className={`retrieved-item ${selected === candidate.id ? 'selected' : ''}`}>
            <Button type="button" variant="ghost" className="retrieved-select h-auto w-full justify-start" onClick={() => onSelect(candidate.id)} aria-expanded={selected === candidate.id}>
              <span><strong>{candidate.label}</strong> {result?.reason ?? 'Retrieved'}</span>
              <small>{candidate.docName} · Chunk {candidate.index + 1}{candidate.page ? ` · p. ${candidate.page}` : ''}</small>
              <p>{candidate.text}</p>
              <small>{run.mode === 'keyword' || run.mode === 'keyword-jev' ? `Chars ${candidate.start}–${candidate.end}` : `Cosine ${candidate.similarity.toFixed(3)}`}{run.mode === 'jev' && ` · JEV ${result?.score?.toFixed(3) ?? 'pending'}`}</small>
            </Button>
            {selected === candidate.id && <div className="expanded-passage">{candidate.text}</div>}
          </div>;
        })}
      </> : <p className="quiet">Ask a question to retrieve chunks.</p>}
    </section>
    {current && !run?.candidates.some(candidate => candidate.id === current.id) && <section className="selected-source"><header><h2>Selected passage</h2></header><small>{current.docName} · Chunk {current.index + 1}</small><div className="expanded-passage">{current.text}</div></section>}
  </aside>;
});

const count = (value: number | null | undefined) => value == null ? 'Not reported' : value.toLocaleString();

function totalCell(value: { value: number; missing: number }, countTotal: number) {
  if (!countTotal) return '0';
  return value.missing === countTotal ? 'Not reported' : `${value.value.toLocaleString()}${value.missing ? ' + unreported' : ''}`;
}

function Tokens({ usage }: { usage: unknown }) {
  const u = tokenUsage(usage);
  return <div className="call-tokens"><span>Input <strong>{count(u.input)}</strong></span><span>Output <strong>{count(u.output)}</strong></span><span>Total <strong>{count(u.total)}</strong></span>{u.cached != null && <span>Cached input {count(u.cached)}</span>}{u.reasoning != null && <span>Reasoning output {count(u.reasoning)}</span>}</div>;
}

function Evidence({ label, source, text }: { label: string; source?: string; text: string }) {
  return <details className="request-passage"><summary>{label}{source ? ` · ${source}` : ''}</summary><div>{text}</div></details>;
}

function CallDetails({ call, index }: { call: ModelCall; index: number }) {
  const state = call.request.state as {
    question: string;
    chunks?: Record<string, { source?: string; text: string }>;
    candidate?: { source?: string; text: string };
    selected_evidence?: Array<{ label: string; source?: string; text: string }>;
  } | undefined;
  const questions = (call.request.questions || {}) as Record<string, { instructions: string; criteria?: { true?: string; false?: string } }>;
  return <details className="model-call"><summary><strong>{call.stage === 'relevance' ? 'Relevance batch' : call.stage === 'contribution' ? 'Contribution check' : call.stage === 'keywords' ? 'Keyword planning' : call.stage === 'rewrite' ? 'Query rewrite' : 'Answer request'} {index + 1}</strong><span>{call.status}{call.ms != null ? ` · ${(call.ms / 1000).toFixed(2)}s` : ''}</span></summary><div className="call-body"><small>{call.model}</small><Tokens usage={call.usage} />{call.firstTextMs != null && <p>First answer text: {(call.firstTextMs / 1000).toFixed(2)}s · Full response: {((call.ms || 0) / 1000).toFixed(2)}s</p>}{call.stage === 'answer' && <p>Reasoning: {call.request.reasoning || 'Provider default'}</p>}
    {state && <><h3>Question</h3><p>{state.question}</p>{state.chunks && <><h3>Passages sent to JEV</h3>{Object.entries(state.chunks).map(([label, chunk]) => <Evidence key={label} label={label} source={chunk.source} text={chunk.text} />)}</>}{state.candidate && <><h3>Candidate</h3><Evidence label="Candidate" source={state.candidate.source} text={state.candidate.text} /><h3>Compared against</h3>{state.selected_evidence?.map(chunk => <Evidence key={chunk.label} label={chunk.label} source={chunk.source} text={chunk.text} />)}</>}<h3>Judgments requested</h3>{Object.entries(questions).map(([label, question]) => <section className="judgment" key={label}><strong>{label}</strong><p>{question.instructions}</p><small>Yes: {question.criteria?.true}</small><small>No: {question.criteria?.false}</small><b>P(yes): {count(call.response?.[label]?.probability ?? call.response?.[label]?.noul)}</b></section>)}</>}
    {(call.stage === 'answer' || call.stage === 'keywords' || call.stage === 'rewrite') && <><h3>System instructions</h3><p className="exact-text">{call.request.system}</p><h3>{call.stage !== 'answer' ? 'Question' : 'Question and retained evidence'}</h3><p className="exact-text">{call.request.prompt}</p><h3>Response</h3><p className="exact-text">{call.response || 'No response received.'}</p></>}
    <details className="raw-request"><summary>Raw request, response and usage</summary><pre>{JSON.stringify({ request: call.request, response: call.response, usage: call.usage }, null, 2)}</pre></details></div></details>;
}

export function RunDetails({
  run,
  runs,
  onSelectRun,
  onSelectChunk,
  initialRates,
  readOnlyRates = false,
}: {
  run?: Run;
  runs: Run[];
  onSelectRun: (id: string) => void;
  onSelectChunk: (id: string) => void;
  initialRates?: Record<string, { input: number | null; cached: number | null; output: number | null }>;
  readOnlyRates?: boolean;
}) {
  const [view, setView] = useState<'usage' | 'jev' | 'gpt' | 'chunks'>('usage');
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [rates, setRates] = useState<Record<string, { input: number | null; cached: number | null; output: number | null }>>(initialRates ?? defaultRates);
  const cost = (calls: ModelCall[], owner: Run | undefined = run) => {
    const value = estimateCost(calls, rates);
    return formatCost({ ...value, missing: value.missing + (owner?.usageIncomplete ? 1 : 0), count: value.count + (owner?.usageIncomplete ? 1 : 0) });
  };

  if (!run) return <div className="run-details quiet">Select a question.</div>;

  const calls = run.calls || [];
  const activeView = view === 'jev' && run.mode !== 'jev' ? 'usage' : view;
  const groups = [
    { name: 'JEV', calls: calls.filter(call => call.stage === 'relevance' || call.stage === 'contribution') },
    { name: 'GPT', calls: calls.filter(call => call.stage === 'answer' || call.stage === 'keywords' || call.stage === 'rewrite') },
  ].filter(group => group.name !== 'JEV' || run.mode === 'jev');
  const tabs: Array<{ key: 'usage' | 'jev' | 'gpt' | 'chunks'; label: string }> = [
    { key: 'usage', label: 'Tokens, cost & timing' },
    ...(run.mode === 'jev' ? [{ key: 'jev' as const, label: 'JEV inputs' }] : []),
    { key: 'gpt', label: 'GPT inputs' },
    { key: 'chunks', label: 'Retrieval' },
  ];

  return <section className="run-details">
    {comparisonOpen && <ComparisonDialog runs={runs} initialGroup={run.groupId} rates={rates} onClose={() => setComparisonOpen(false)} onInspect={id => { setComparisonOpen(false); onSelectRun(id); }} />}
    <Button type="button" variant="outline" className="compare-results-button" onClick={() => setComparisonOpen(true)}>Compare results · table & charts</Button>
    <header><h2>{runLabel(run)}</h2><p>{run.question}</p>{run.retrievalQuery && <p>Search query: {run.retrievalQuery}</p>}{run.retryOf && <p className="usage-note">Retry totals include the first attempt and query rewrite. The original question is still used for JEV and the answer.</p>}</header>
    {runs.filter(item => item.groupId === run.groupId).length > 1 && <div className="comparison-table">
      <Table className="usage-table">
        <TableHeader>
          <TableRow>
            <TableHead>Mode</TableHead>
            <TableHead>Passages sent</TableHead>
            <TableHead>Total tokens</TableHead>
            <TableHead>Est. cost (USD)</TableHead>
            <TableHead>Elapsed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.filter(item => item.groupId === run.groupId).map(item => <TableRow key={item.id}>
            <TableHead className="whitespace-normal">
              <Button type="button" variant="link" className="h-auto p-0 text-left" aria-pressed={item.id === run.id} onClick={() => onSelectRun(item.id)}>{runLabel(item)}</Button>
              <small>{item.phase}</small>
            </TableHead>
            <TableCell>{item.context ? item.ranked.filter(candidate => candidate.kept).length : 'Pending'}</TableCell>
            <TableCell>{item.usageIncomplete ? 'Unreported' : totalCell(sumUsage(item.calls || []).total, (item.calls || []).length)}</TableCell>
            <TableCell>{!item.calls?.length && !['done', 'error', 'cancelled'].includes(item.phase) ? 'Pending' : cost(item.calls || [], item)}</TableCell>
            <TableCell>{item.elapsedMs != null ? `${(item.elapsedMs / 1000).toFixed(2)}s` : 'Running'}</TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
    </div>}
    <nav aria-label="Question details">{tabs.map(tab => <Button key={tab.key} type="button" variant="ghost" size="sm" aria-pressed={activeView === tab.key} onClick={() => setView(tab.key)}>{tab.label}</Button>)}</nav>
    {activeView === 'usage' && <>
      {run.searchTerms && run.searchTerms.length > 0 && <Accordion type="single" collapsible><AccordionItem value="search-terms"><AccordionTrigger>Search patterns tried ({run.searchTerms.length})</AccordionTrigger><AccordionContent><ol className="list-decimal space-y-1 pl-5 text-sm">{run.searchTerms.map((pattern, index) => <li key={index}><code>{pattern}</code></li>)}</ol></AccordionContent></AccordionItem></Accordion>}
      <h3>Token usage</h3>
      <Table className="usage-table">
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead>Requests</TableHead>
            <TableHead>Input</TableHead>
            <TableHead>Output</TableHead>
            <TableHead>Total</TableHead>
            <TableHead>Est. cost (USD)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map(group => {
            const sum = sumUsage(group.calls);
            return <TableRow key={group.name}>
              <TableHead>{group.name}</TableHead>
              <TableCell>{group.calls.length}</TableCell>
              {(['input', 'output', 'total'] as const).map(key => <TableCell key={key}>{totalCell(sum[key], group.calls.length)}</TableCell>)}
              <TableCell>{cost(group.calls)}</TableCell>
            </TableRow>;
          })}
        </TableBody>
      </Table>
      <p><strong>Total estimated cost: {cost(calls)}</strong></p>
      {!readOnlyRates && <details className="model-call"><summary>Pricing · USD per million tokens</summary><div className="call-body">
        <Table className="usage-table">
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Input</TableHead>
              <TableHead>Cached input</TableHead>
              <TableHead>Output</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Object.entries(rates).map(([model, rate]) => <TableRow key={model}>
              <TableHead>{model}</TableHead>
              {(['input', 'cached', 'output'] as const).map(kind => <TableCell key={kind}>
                <Input
                  aria-label={`${model} ${kind} price per million tokens`}
                  type="number"
                  min="0"
                  step="any"
                  value={rate[kind] ?? ''}
                  className="w-[90px]"
                  onChange={event => {
                    const value = event.target.value === '' ? null : event.target.valueAsNumber;
                    setRates(previous => ({
                      ...previous,
                      [model]: {
                        ...previous[model],
                        [kind]: value != null && Number.isFinite(value) && value >= 0 ? value : null,
                      },
                    }));
                  }}
                />
              </TableCell>)}
            </TableRow>)}
          </TableBody>
        </Table>
        <Button type="button" variant="outline" onClick={() => setRates(defaultRates)}>Reset published rates</Button>
        <p>Estimates use these rates for all displayed runs. Editing rates recalculates existing results. Rates apply to this page session.</p>
        <p>Defaults checked September 18, 2026: <a href="https://docs.typesafe.ai/models" target="_blank" rel="noreferrer">TypeSafe</a> · <a href="https://ai-gateway.vercel.sh/v1/models" target="_blank" rel="noreferrer">Vercel model catalog</a>.</p>
        <p>Output includes reasoning tokens. Cached input is discounted when reported; otherwise input uses the standard rate. Missing usage is unreported. Excludes credits, taxes, provider-specific adjustments and local compute.</p>
      </div></details>}
      {readOnlyRates && <p className="usage-note">Costs use the saved pricing snapshot for this benchmark.</p>}
      {run.usageIncomplete && <p className="run-error">This attempt was interrupted. Some usage and charges may be unreported.</p>}
      <p className="usage-note">{run.mode === 'jev' && 'JEV includes relevance and contribution requests. '}GPT includes keyword planning and query rewriting when used. Counts are reported by the providers. Unreported usage is not treated as zero.</p>
      <h3>Timing</h3>
      {run.elapsedMs != null && <p>Total elapsed: {(run.elapsedMs / 1000).toFixed(2)}s</p>}
      <dl className="timing-list"><dt>{run.mode === 'keyword' || run.mode === 'keyword-jev' ? 'Search and answer, combined' : 'Local retrieval, including startup'}</dt><dd>{run.retrievalMs != null ? `${(run.retrievalMs / 1000).toFixed(2)}s` : 'Pending'}</dd>{Object.entries(run.retrievalTimings || {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{(value / 1000).toFixed(2)}s</dd></div>)}{['rewrite', 'keywords', 'relevance', 'contribution', 'answer'].filter(stage => calls.some(call => call.stage === stage)).map(stage => <div key={stage}><dt>{stage === 'answer' ? 'GPT answer' : stage === 'keywords' ? 'GPT keyword planning' : stage === 'rewrite' ? 'GPT query rewrite' : `JEV ${stage}`}</dt><dd>{(calls.filter(call => call.stage === stage).reduce((sum, call) => sum + (call.ms || 0), 0) / 1000).toFixed(2)}s</dd></div>)}</dl>{calls.some(call => call.status === 'running') && <p className="quiet">Usage updates as requests finish.</p>}
    </>}
    {(activeView === 'jev' || activeView === 'gpt') && <>{!calls.length && <p className="quiet">No request trace is available for this run.</p>}{calls.filter(call => activeView === 'gpt' ? (call.stage === 'answer' || call.stage === 'keywords' || call.stage === 'rewrite') : (call.stage === 'relevance' || call.stage === 'contribution')).map((call, index) => <CallDetails key={call.id} call={call} index={index} />)}{activeView === 'gpt' && calls.length > 0 && !calls.some(call => call.stage === 'answer' || call.stage === 'keywords' || call.stage === 'rewrite') && <p className="quiet">GPT has not been called for this question.</p>}{activeView === 'jev' && calls.length > 0 && !calls.some(call => call.stage === 'relevance' || call.stage === 'contribution') && <p className="quiet">JEV has not been called for this question.</p>}</>}
    {activeView === 'chunks' && <PipelinePanel run={run} onSelectChunk={onSelectChunk} />}
  </section>;
}
