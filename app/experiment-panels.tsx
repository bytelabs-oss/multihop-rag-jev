'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, LoaderCircle, Square, MessageSquare, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { defaultSettings, modeLabels, runLabel, type ComparisonMode, type Run, type Settings } from '../lib/experiment';
import { DatasetQuestions } from './dataset-questions';
import type { Doc } from '../lib/documents';

export function ChatPanel({
  runs,
  activeId,
  onSelect,
  onAsk,
  onStop,
  busy,
  hasChunks,
  configured,
  cancellable,
  documents,
}: {
  runs: Run[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAsk: (q: string, s: Settings, mode: ComparisonMode | 'all', referenceAnswer?: string) => void;
  onStop: () => void;
  busy: boolean;
  hasChunks: boolean;
  configured: boolean | null;
  cancellable: boolean;
  documents: readonly Pick<Doc, 'id'>[];
}) {
  const [question, setQuestion] = useState('');
  const [referenceAnswer, setReferenceAnswer] = useState('');
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const chooseQuestion = useCallback((value: string, answer: string) => {
    setQuestion(value);
    setReferenceAnswer(answer);
    requestAnimationFrame(() => {
      questionInput.current?.focus();
      questionInput.current?.setSelectionRange(value.length, value.length);
    });
  }, []);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const groups = Array.from(new Set(runs.map(run => run.groupId))).map(id => ({ id, runs: runs.filter(run => run.groupId === id) }));
  useEffect(() => {
    const active = runs.find(run => run.id === activeId);
    if (!active) return;
    const frame = requestAnimationFrame(() => setExpandedGroup(active.groupId));
    return () => cancelAnimationFrame(frame);
  }, [activeId, runs]);
  const [mode, setMode] = useState<ComparisonMode | 'all'>('jev');
  const [settings, setSettings] = useState<Omit<Settings, 'semanticThreshold'>>({ topK: defaultSettings.topK, threshold: defaultSettings.threshold });

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity() || !question.trim() || busy || !hasChunks || !configured) return;
    onAsk(question.trim(), { ...settings, semanticThreshold: defaultSettings.semanticThreshold }, mode, referenceAnswer.trim() || undefined);
    setQuestion('');
    setReferenceAnswer('');
  }

  return <aside className="experiment-chat">
    <header><MessageSquare size={18} /><h2>Chat</h2><span>{configured === null ? 'Checking models' : configured ? 'Models connected' : 'Model credentials unavailable'}</span></header>
    <label className="mode-selector">
      <span>Mode</span>
      <NativeSelect aria-label="Experiment mode" value={mode} disabled={busy} onChange={event => setMode(event.target.value as ComparisonMode | 'all')}>
        {Object.entries(modeLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
        <NativeSelectOption value="all">Compare all four</NativeSelectOption>
      </NativeSelect>
    </label>
    <div className="experiment-controls">
      <label>
        <span>Maximum candidates</span>
        <Input
          type="number"
          aria-label="Maximum candidates"
          aria-describedby="retrieval-help"
          form="atlas-question-form"
          required
          title="Maximum shared hybrid results after score filtering and RRF. Fewer or zero candidates can qualify. This does not limit the rg keyword search."
          min={1}
          step={1}
          disabled={busy || mode === 'keyword' || mode === 'keyword-jev'}
          value={Number.isFinite(settings.topK) ? settings.topK : ''}
          onChange={event => setSettings(current => ({ ...current, topK: event.target.valueAsNumber }))}
        />
      </label>
      <label>
        <span>JEV relevance ≥</span>
        <Input
          type="number"
          aria-label="JEV relevance threshold"
          min={0}
          max={1}
          step={0.05}
          disabled={busy || !['jev', 'keyword-jev', 'all'].includes(mode)}
          value={settings.threshold}
          onChange={event => setSettings(current => ({ ...current, threshold: Number(event.target.value) }))}
        />
      </label>
      <p id="retrieval-help" className="retrieval-help">Vector and BM25 filters are fixed. Both hybrid modes receive the same candidates, up to the maximum.</p>
    </div>
    <div className="retry-choice">
      <label>
        <Checkbox
          checked={!!settings.retryOnEmpty}
          disabled={busy || (mode !== 'jev' && mode !== 'all')}
          onCheckedChange={checked => setSettings(current => ({ ...current, retryOnEmpty: checked === true }))}
        />
        Retry once if JEV keeps no evidence
      </label>
      {settings.retryOnEmpty && <p>GPT rewrites the search query. The retry is labelled separately and includes the first attempt usage.</p>}
    </div>
    <div className="chat-history" aria-live="polite">
      {groups.map(group => {
        const open = expandedGroup === group.id;
        const run = group.runs.find(result => result.id === activeId) || group.runs[0];
        const pending = group.runs.filter(result => !['done', 'error', 'cancelled'].includes(result.phase)).length;
        return <article key={group.id} className={`chat-run question-group ${open ? 'active-run' : ''}`}>
          <Button
            type="button"
            variant="ghost"
            className="run-question h-auto w-full justify-start px-4 py-3"
            aria-expanded={open}
            aria-controls={`question-${group.id}`}
            onClick={() => {
              if (open) setExpandedGroup(null);
              else {
                setExpandedGroup(group.id);
                onSelect(run.id);
              }
            }}
          >
            <span>{group.runs.length} {group.runs.length === 1 ? 'result' : 'results'}{pending ? ` · ${pending} running` : ''}</span>
            <strong>{run.question}</strong>
            <ChevronRight size={16} />
          </Button>
          {open && <div id={`question-${group.id}`}>
            <nav className="question-modes" aria-label="Results for this question">
              {group.runs.map(result => <Button
                key={result.id}
                type="button"
                variant="ghost"
                className="h-auto justify-start"
                aria-pressed={run.id === result.id}
                onClick={() => onSelect(result.id)}
              >
                <span>{runLabel(result)}</span>
                <small>{result.phase}</small>
              </Button>)}
            </nav>
            <div className="run-answer" onClick={event => { if (!(event.target as Element).closest('button')) onSelect(run.id); }}>
              {run.answer ? <Answer text={run.answer} run={run} onSelect={() => onSelect(run.id)} /> : run.error ? <p className="run-error">{run.error}</p> : run.phase === 'cancelled' ? <p className="quiet">Run stopped.</p> : <p className="run-working"><LoaderCircle className="spin" size={15} />{run.progress || ({ searching: 'Searching documents with regular expressions', embedding: 'Embedding and searching locally', retrieved: 'Candidates retrieved', ranking: 'JEV relevance scoring', selecting: 'JEV evidence selection', answering: 'Answering from selected evidence', done: 'Complete', error: 'Request failed' })[run.phase]}</p>}
              {run.answer && run.phase === 'answering' && <p className="quiet">Generating…</p>}
              {run.answer && run.error && <p className="run-error">{run.error} Partial answer.</p>}
              {run.answer && run.phase === 'cancelled' && <p className="quiet">Run stopped. Partial answer.</p>}
              <Button type="button" variant="link" className="trace-link h-auto p-0" onClick={() => onSelect(run.id)}>
                Usage & inputs · {run.candidates.length} retrieved · {run.ranked.filter(candidate => candidate.kept).length} kept
              </Button>
            </div>
          </div>}
        </article>;
      })}
    </div>
    <DatasetQuestions onChoose={chooseQuestion} disabled={busy} documents={documents} />
    {referenceAnswer && <p className="reference-answer-note">Reference answer attached: <strong>{referenceAnswer}</strong> <Button type="button" variant="link" className="h-auto p-0 text-muted-foreground" onClick={() => setReferenceAnswer('')}>Remove</Button></p>}
    <form id="atlas-question-form" className="chat-compose" onSubmit={submit}>
      <Textarea
        ref={questionInput}
        aria-label="Question about the documents"
        placeholder={hasChunks ? 'Ask a question about your documents…' : 'Add documents to begin…'}
        value={question}
        onChange={event => {
          setQuestion(event.target.value);
          setReferenceAnswer('');
        }}
        disabled={!hasChunks}
        className="min-h-[65px] max-h-40 resize-y border-0 bg-transparent p-0 text-[14px] leading-[1.7] shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
      />
      <div>
        {cancellable ? <Button type="button" variant="ghost" className="stop-run h-auto p-0" onClick={onStop}><Square size={13} /> Stop</Button> : <Button className="ask-button size-9 p-0" type="submit" disabled={busy || !hasChunks || !question.trim() || !configured} aria-label="Run question"><ArrowUp size={19} /></Button>}
      </div>
    </form>
  </aside>;
}

export function Answer({ text, run, onSelect }: { text: string; run: Run; onSelect: () => void }) {
  return <div className="answer-text">
    {text.split(/(\[C\d+\])/g).map((part, index) => {
      const label = part.slice(1, -1);
      const chunk = run.candidates.find(candidate => candidate.label === label);
      return chunk && run.ranked.some(candidate => candidate.id === chunk.id && candidate.kept)
        ? <Button
          key={index}
          type="button"
          variant="ghost"
          size="xs"
          className="citation h-auto rounded-sm px-[3px] py-0 align-baseline text-[12px] font-normal"
          title={`${chunk.docName}, chunk ${chunk.index + 1}`}
          onClick={() => {
            onSelect();
            window.dispatchEvent(new CustomEvent('atlas-select-chunk', { detail: chunk.id }));
          }}
        >
          {part}
        </Button>
        : part;
    })}
  </div>;
}

export function PipelinePanel({ run, onSelectChunk }: { run: Run | undefined; onSelectChunk: (id: string) => void }) {
  if (!run) return null;
  const byId = new Map(run.ranked.map(candidate => [candidate.id, candidate]));
  const ordered = run.ranked.length ? run.ranked.map(result => run.candidates.find(candidate => candidate.id === result.id)!).filter(Boolean) : run.candidates;
  const final = !!run.context;
  const kept = run.ranked.filter(candidate => candidate.kept).length;

  return <section className="pipeline-panel">
    <header><h2>Pipeline trace</h2><span>{run.candidates.length} retrieved <ChevronRight size={12} />{kept} kept {final && `· ${run.candidates.length - kept} dropped`}</span></header>
    <p className="trace-question">{run.question}</p>
    <div className="trace-table-wrap">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Chunk</TableHead>
            <TableHead title="Original retrieval rank">Retr.</TableHead>
            <TableHead>Cosine</TableHead>
            <TableHead>BM25</TableHead>
            <TableHead title="Reciprocal rank fusion">RRF</TableHead>
            <TableHead>JEV P(useful)</TableHead>
            <TableHead>P(adds evidence)</TableHead>
            <TableHead>Decision</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.map(candidate => {
            const rank = byId.get(candidate.id);
            return <TableRow key={candidate.id} className={rank?.kept ? 'kept-row' : rank && rank.reason !== 'Awaiting selection' ? 'dropped-row' : ''}>
              <TableCell className="whitespace-normal">
                <Button type="button" variant="link" className="h-auto p-0 text-left" onClick={() => onSelectChunk(candidate.id)} title={candidate.docName}>
                  <strong>{candidate.label}</strong> {candidate.docName} · {candidate.index + 1}
                </Button>
              </TableCell>
              <TableCell>#{candidate.retrievalRank}</TableCell>
              <TableCell>{(run.mode === 'keyword' || run.mode === 'keyword-jev') ? '—' : candidate.similarity.toFixed(3)}</TableCell>
              <TableCell>{(run.mode === 'keyword' || run.mode === 'keyword-jev') ? '—' : candidate.bm25Score.toFixed(2)}</TableCell>
              <TableCell>{(run.mode === 'keyword' || run.mode === 'keyword-jev') ? '—' : candidate.hybridScore.toFixed(4)}</TableCell>
              <TableCell>{rank?.score?.toFixed(3) ?? '—'}</TableCell>
              <TableCell>{rank?.noveltyScore?.toFixed(3) ?? '—'}</TableCell>
              <TableCell><span className={rank?.kept ? 'decision-keep' : 'decision-drop'}>{rank?.reason ?? 'Retrieved'}</span></TableCell>
            </TableRow>;
          })}
        </TableBody>
      </Table>
    </div>
    <div className="trace-notes">
      {run.mode !== 'keyword' && run.mode !== 'keyword-jev' && <span>Maximum candidates {run.settings.topK} · Vector cutoff {run.settings.semanticThreshold?.toFixed(2) ?? 'Not recorded'} · Positive BM25 matches also qualify</span>}
      {(run.mode === 'jev' || run.mode === 'keyword-jev') && <span>Relevance ≥ {run.settings.threshold.toFixed(2)} · Drop contribution below 0.20; retain uncertain scores</span>}
      <span>{run.retrievalMs !== undefined && `Retrieval ${(run.retrievalMs / 1000).toFixed(2)}s`}{run.jevMs !== undefined && ` · JEV ${(run.jevMs / 1000).toFixed(2)}s`}{run.llmMs !== undefined && ` · Answer ${(run.llmMs / 1000).toFixed(2)}s`}</span>
    </div>
    <details className="trace-details"><summary>Inspect exact model inputs and outputs</summary><h3>JEV relevance questions</h3><pre>{JSON.stringify(run.questions, null, 2) || 'Waiting for JEV'}</pre><h3>JEV relevance responses</h3><pre>{JSON.stringify(run.jevAnswers, null, 2) || 'Waiting for JEV'}</pre><h3>JEV contribution checks</h3><pre>{JSON.stringify(run.selection, null, 2) || 'No contribution checks completed yet'}</pre><h3>{kept ? 'Exact answer-model context' : 'Prepared context, answer model not called'}</h3><pre>{run.context ? JSON.stringify(run.context, null, 2) : 'Context is not selected yet.'}</pre><h3>Model usage</h3><pre>{JSON.stringify({ relevance: run.jevUsage, answer: run.llmUsage }, null, 2)}</pre></details>
  </section>;
}
