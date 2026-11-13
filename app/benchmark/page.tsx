'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
import { defaultSettings, modeLabels, type ComparisonMode } from '../../lib/experiment';
import { assertBenchmarkCompatible, benchmarkDependencies, createBenchmarkJob, loadBenchmarkDataset, prepareBenchmarkCorpus, type BenchmarkDataset } from '../../lib/benchmark-client';
import { executeBenchmark } from '../../lib/benchmark-runner.mjs';
import { summarizeBenchmark } from '../../lib/benchmark-metrics.mjs';
import { getBenchmarkQuestion, listBenchmarkJobs, listBenchmarkSummaries, saveBenchmarkJob } from '../../lib/benchmark-store';
import type { BenchmarkJob, BenchmarkProgress, BenchmarkRecord, BenchmarkSummary } from '../../lib/benchmark-types';
import { BenchmarkQuestionDetails } from './question-details';
import './benchmark.css';

type ModelConfig = { answerConfigured: boolean; jevConfigured: boolean; llmModel: string; jevModel: string };

const MODES: ComparisonMode[] = ['hybrid', 'jev', 'keyword', 'keyword-jev'];
const PAGE_SIZE = 25;
const message = (error: unknown) => error instanceof Error ? error.message : 'The benchmark operation failed.';
const percent = (value: number | null) => value === null ? 'Not scored' : `${(value * 100).toFixed(1)}%`;
const decimal = (value: number | null) => value === null ? 'Not scored' : value.toFixed(4);
const money = (cost: number, unreported: number) => unreported && !cost ? 'Unreported' : `$${cost.toFixed(6)}${unreported ? ' + unreported' : ''}`;

export default function BenchmarkPage() {
  const [dataset, setDataset] = useState<BenchmarkDataset | null>(null);
  const [models, setModels] = useState<ModelConfig | null>(null);
  const [jobs, setJobs] = useState<BenchmarkJob[]>([]);
  const [job, setJob] = useState<BenchmarkJob | null>(null);
  const [summaries, setSummaries] = useState<BenchmarkSummary[]>([]);
  const [modes, setModes] = useState<ComparisonMode[]>([...MODES]);
  const [topK, setTopK] = useState(defaultSettings.topK);
  const [threshold, setThreshold] = useState(defaultSettings.threshold);
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [setupError, setSetupError] = useState('');
  const [preparation, setPreparation] = useState<{ done: number; total: number; message: string } | null>(null);
  const [progress, setProgress] = useState<BenchmarkProgress | null>(null);
  const [detail, setDetail] = useState<BenchmarkRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const [evidenceStage, setEvidenceStage] = useState<'retrieval' | 'selected'>('retrieval');
  const controller = useRef<AbortController | null>(null);
  const currentJob = useRef<BenchmarkJob | null>(null);
  const selectedQuestion = useRef<number | null>(null);

  useEffect(() => {
    const setup = new AbortController();
    void Promise.all([
      loadBenchmarkDataset(setup.signal),
      fetch('/api/experiment', { signal: setup.signal }).then(async response => {
        if (!response.ok) throw new Error('Could not read model configuration.');
        const config: ModelConfig = await response.json();
        if (typeof config.answerConfigured !== 'boolean' || typeof config.jevConfigured !== 'boolean' || typeof config.llmModel !== 'string' || typeof config.jevModel !== 'string') throw new Error('The model configuration response is invalid.');
        return config;
      }),
    ]).then(([data, config]) => {
      if (!setup.signal.aborted) {
        setDataset(data);
        setModels(config);
      }
    }).catch(cause => {
      if (!setup.signal.aborted) setSetupError(message(cause));
    });
    void listBenchmarkJobs().then(async saved => {
      if (setup.signal.aborted) return;
      setJobs(previous => [...previous, ...saved.filter(item => !previous.some(existing => existing.id === item.id))]);
      if (saved[0] && currentJob.current === null && !controller.current) {
        currentJob.current = saved[0];
        setJob(saved[0]);
        const rows = await listBenchmarkSummaries(saved[0].id);
        summarizeBenchmark(saved[0], rows);
        if (!setup.signal.aborted && currentJob.current?.id === saved[0].id) setSummaries(rows);
      }
    }).catch(cause => {
      if (!setup.signal.aborted) setError(message(cause));
    });
    return () => {
      setup.abort();
      controller.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);

  const selectedModes = job?.modes ?? modes;
  const settings = job?.settings ?? { topK, threshold };
  const stats = useMemo(() => job ? summarizeBenchmark(job, summaries) : [], [job, summaries]);
  const byQuestion = useMemo(() => new Map(summaries.map(row => [row.index, row])), [summaries]);
  const questions = useMemo(() => {
    const rows = dataset && (!job || dataset.manifest.questionsSha256 === job.manifest.questionsSha256)
      ? dataset.questions.map(question => ({ index: question.index, query: question.query, questionType: question.questionType }))
      : summaries;
    const terms = filter.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return rows.filter(row => terms.every(term => row.query.toLowerCase().includes(term)));
  }, [dataset, job, summaries, filter]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(questions.length / PAGE_SIZE) - 1));
  const processed = summaries.reduce((sum, row) => sum + selectedModes.filter(mode => row.modes[mode]?.settled).length, 0);
  const expected = (job?.manifest.questions ?? dataset?.manifest.questions ?? 2556) * selectedModes.length;
  const finished = job?.status === 'completed' || job?.status === 'completed_with_errors';
  const configured = !!models?.answerConfigured && ((!selectedModes.includes('jev') && !selectedModes.includes('keyword-jev')) || !!models?.jevConfigured);

  function showJob(next: BenchmarkJob | null) {
    currentJob.current = next;
    setJob(next);
    setConfirmed(false);
    setProgress(null);
    setPreparation(null);
    setSummaries([]);
    setDetail(null);
    selectedQuestion.current = null;
    setPage(0);
    setError('');
  }

  async function chooseJob(id: string) {
    if (controller.current) return;
    const next = jobs.find(item => item.id === id) ?? null;
    showJob(next);
    if (!next) return;
    try {
      const rows = await listBenchmarkSummaries(next.id);
      summarizeBenchmark(next, rows);
      if (currentJob.current?.id === next.id) setSummaries(rows);
    } catch (cause) {
      setError(message(cause));
    }
  }

  async function inspectQuestion(index: number) {
    if (!job) return;
    const jobId = job.id;
    selectedQuestion.current = index;
    setDetailLoading(true);
    setError('');
    try {
      const record = await getBenchmarkQuestion(jobId, index);
      if (!record) throw new Error('This question has no saved result yet.');
      if (currentJob.current?.id === jobId && selectedQuestion.current === index) setDetail(record);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setDetailLoading(false);
    }
  }

  async function start(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (controller.current) return;
    if (!event.currentTarget.reportValidity()) return;
    if (!confirmed || !dataset || !models || !configured) {
      setError('Load the dataset, configure the selected models, and confirm the paid run first.');
      return;
    }
    if (!navigator.locks) {
      setError('This browser cannot lock resumable benchmark runs. Use a current browser.');
      return;
    }
    const signalController = new AbortController();
    controller.current = signalController;
    setRunning(true);
    setError('');
    setProgress(null);
    setPreparation(null);
    try {
      let active = job ?? createBenchmarkJob(dataset, modes, { topK, threshold }, { jev: models.jevModel, answer: models.llmModel });
      assertBenchmarkCompatible(active, dataset, { jev: models.jevModel, answer: models.llmModel });
      if (!job) {
        currentJob.current = active;
        setJob(active);
        setSummaries([]);
      }
      await navigator.locks.request(`atlas-benchmark:${active.id}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('This benchmark is already running in another tab.');
        active = { ...active, status: 'running', updated: new Date().toISOString(), error: undefined };
        currentJob.current = active;
        setJob(active);
        await saveBenchmarkJob(active);
        setJobs(previous => [active, ...previous.filter(item => item.id !== active.id)]);
        try {
          const documents = await prepareBenchmarkCorpus(dataset, (done, total, text) => setPreparation({ done, total, message: text }), signalController.signal);
          setPreparation(null);
          const dependencies = benchmarkDependencies(active, documents, {
            progress: setProgress,
            saved: (summary, record) => {
              setSummaries(previous => [...previous.filter(row => row.index !== summary.index), summary].sort((a, b) => a.index - b.index));
              if (selectedQuestion.current === record.index) setDetail(structuredClone(record));
            },
          });
          const status = await executeBenchmark(active, dataset.questions, documents, dependencies, signalController.signal);
          active = { ...active, status, updated: new Date().toISOString() };
          await saveBenchmarkJob(active);
        } catch (cause) {
          active = { ...active, status: signalController.signal.aborted ? 'paused' : 'error', updated: new Date().toISOString(), error: signalController.signal.aborted ? undefined : message(cause) };
          if (active.error) setError(active.error);
          try {
            await saveBenchmarkJob(active);
          } catch (storageError) {
            setError(`${message(cause)} Progress could not be saved: ${message(storageError)}`);
          }
        }
        currentJob.current = active;
        setJob(active);
        setJobs(previous => [active, ...previous.filter(item => item.id !== active.id)]);
      });
    } catch (cause) {
      setError(message(cause));
    } finally {
      controller.current = null;
      setRunning(false);
      setConfirmed(false);
    }
  }

  function exportResults() {
    if (!job) return;
    const payload = {
      job,
      overall: stats,
      questions: summaries,
      note: 'Repository-compatible answer scoring is any-token overlap, not semantic accuracy. Partial results are not a full benchmark. Detailed traces remain saved in this browser.',
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `atlas-benchmark-${job.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <main className="benchmark-page">
    <header className="benchmark-header">
      <div><h1>MultiHop-RAG benchmark</h1><p>Atlas pipelines on the full corpus, with overall results and individual question traces.</p></div>
      <a href="/" target="_blank" rel="noopener noreferrer">Open workspace</a>
    </header>
    <p className="benchmark-protocol">609 articles. 2,556 questions, including 301 intentional no-answer cases. This evaluates Atlas, not the model configuration in the paper.</p>
    {setupError && <p className="benchmark-error" role="alert">{setupError} Refresh this page to retry setup.</p>}
    {error && <p className="benchmark-error" role="alert">{error}</p>}
    {!dataset && !setupError && <p role="status">Loading and verifying the benchmark files...</p>}

    <section className="benchmark-setup" aria-labelledby="benchmark-setup-title">
      <div className="benchmark-setup-heading"><h2 id="benchmark-setup-title">Run setup</h2>
        <label>
          <span>Saved run</span>
          <NativeSelect disabled={running} value={job?.id ?? ''} onChange={event => void chooseJob(event.target.value)}>
            <NativeSelectOption value="">New benchmark</NativeSelectOption>
            {jobs.map(item => <NativeSelectOption key={item.id} value={item.id}>{new Date(item.created).toLocaleString()} - {item.status.replaceAll('_', ' ')}</NativeSelectOption>)}
          </NativeSelect>
        </label>
      </div>
      <form onSubmit={start}>
        <fieldset disabled={running || !!job}><legend>Modes</legend>
          {MODES.map(mode => <label key={mode}><Checkbox checked={selectedModes.includes(mode)} onCheckedChange={checked => {
            setModes(previous => checked === true ? MODES.filter(item => item === mode || previous.includes(item)) : previous.filter(item => item !== mode));
            setConfirmed(false);
          }} />{modeLabels[mode]}</label>)}
        </fieldset>
        <div className="benchmark-settings">
          <label>
            <span>Maximum hybrid candidates</span>
            <Input type="number" min={10} step={1} required disabled={running || !!job} value={Number.isFinite(settings.topK) ? settings.topK : ''} onChange={event => { setTopK(event.target.valueAsNumber); setConfirmed(false); }} />
          </label>
          <label>
            <span>JEV relevance</span>
            <Input type="number" min={0} max={1} step="any" required disabled={running || !!job} value={Number.isFinite(settings.threshold) ? settings.threshold : ''} onChange={event => { setThreshold(event.target.valueAsNumber); setConfirmed(false); }} />
          </label>
        </div>
        <p className="benchmark-help">Retrieval filters stay fixed. Both hybrid modes share the same retrieval for each question. Automatic query-rewrite retries are off. Corpus preparation reuses saved embeddings and does not replace the documents loaded in your workspace.</p>
        {!configured && models && <p className="benchmark-error">Configure AI_GATEWAY_API_KEY{(selectedModes.includes('jev') || selectedModes.includes('keyword-jev')) ? ' and TYPESAFE_API_KEY' : ''} before starting these modes.</p>}
        {!finished && <label className="benchmark-confirm"><Checkbox required checked={confirmed} disabled={running} onCheckedChange={checked => setConfirmed(checked === true)} />
          I understand this schedules up to {expected.toLocaleString()} question-mode executions and can incur provider charges. Resuming can repeat an interrupted request.
        </label>}
        <div className="benchmark-actions">
          {!finished && <Button type="submit" disabled={running || !confirmed || !dataset || !configured || !selectedModes.length}>{job ? 'Resume unfinished work' : 'Start full benchmark'}</Button>}
          {running && <Button type="button" variant="outline" onClick={() => controller.current?.abort()}>Pause</Button>}
          {job && <Button type="button" variant="outline" disabled={running} onClick={() => showJob(null)}>New benchmark</Button>}
          {!!summaries.length && <Button type="button" variant="outline" onClick={exportResults}>Export overall and question results</Button>}
        </div>
      </form>
    </section>

    {job && <section className="benchmark-progress" aria-live="polite">
      <h2>{job.status.replaceAll('_', ' ')}</h2>
      {preparation && <><p>{preparation.message}</p><progress value={preparation.done} max={preparation.total} /><p>{preparation.done} / {preparation.total} articles prepared</p></>}
      {!preparation && <><progress value={processed} max={expected || 1} /><p>{processed.toLocaleString()} / {expected.toLocaleString()} question-mode runs processed</p></>}
      {running && progress && <p>Question {progress.questionIndex + 1} / {job.manifest.questions} · {modeLabels[progress.mode]} · {progress.stage}</p>}
      {job.status === 'error' && job.error && <p>{job.error}</p>}
      <p className="benchmark-help">Completed mode results are saved. Pausing interrupts the current request; its usage may be incomplete. A finished run with errors is not a fully scored benchmark.</p>
    </section>}

    {job && <section className="benchmark-overall" aria-labelledby="benchmark-overall-title">
      <h2 id="benchmark-overall-title">Overall results</h2>
      <p className="benchmark-warning">The repository answer score accepts any shared word with the reference. It is a permissive overlap score, not proof that an answer is correct. Scores below use completed predictions only; check the scored counts before comparing partial runs.</p>
      <p className="benchmark-help">GPT answer columns cover completed answer-generation calls. Whole-run totals include all model work and previous attempts. Unreported usage is not treated as zero.</p>
      <div className="benchmark-table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mode</TableHead>
              <TableHead>Scored</TableHead>
              <TableHead>Failed</TableHead>
              <TableHead>Repository overlap</TableHead>
              <TableHead>GPT answer tokens</TableHead>
              <TableHead>GPT answer cost</TableHead>
              <TableHead>Total tokens</TableHead>
              <TableHead>Total cost</TableHead>
              <TableHead>Coverage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stats.map(row => <TableRow key={row.mode}>
              <TableHead className="whitespace-normal">{modeLabels[row.mode]}<small>{row.answerCalls} GPT answers</small></TableHead>
              <TableCell>{row.completed.toLocaleString()} / {row.total.toLocaleString()}</TableCell>
              <TableCell>{row.failed}</TableCell>
              <TableCell>{percent(row.answerOverlap)}</TableCell>
              <TableCell>{row.answerTokens === null ? 'Unreported' : row.answerTokens.toLocaleString()}</TableCell>
              <TableCell>{row.answerCost === null ? 'Unreported' : money(row.answerCost, 0)}</TableCell>
              <TableCell>{row.tokens === null ? 'Unreported' : row.tokens.toLocaleString()}</TableCell>
              <TableCell>{money(row.cost, row.unreported)}</TableCell>
              <TableCell>{row.full ? 'Full' : 'Partial'}</TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
      </div>
      <details className="benchmark-scoring">
        <summary>Retrieval scores and question types</summary>
        <label>
          <span>Evidence stage</span>
          <NativeSelect value={evidenceStage} onChange={event => setEvidenceStage(event.target.value === 'selected' ? 'selected' : 'retrieval')}>
            <NativeSelectOption value="retrieval">Retrieved candidates</NativeSelectOption>
            <NativeSelectOption value="selected">Passages sent to the answer model</NativeSelectOption>
          </NativeSelect>
        </label>
        <p>These require the complete gold fact inside a chunk, ignoring ordinary spaces and newlines. Null queries are excluded. Repository MAP uses the formula in the published code, not textbook average precision.</p>
        <div className="benchmark-table">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mode</TableHead>
                <TableHead>Scored queries</TableHead>
                <TableHead>Hits@4</TableHead>
                <TableHead>Hits@10</TableHead>
                <TableHead>MRR@10</TableHead>
                <TableHead>Repository MAP@10</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.map(row => <TableRow key={row.mode}>
                <TableHead>{modeLabels[row.mode]}</TableHead>
                <TableCell>{row.retrievalCount}</TableCell>
                <TableCell>{percent(row[evidenceStage].hits4)}</TableCell>
                <TableCell>{percent(row[evidenceStage].hits10)}</TableCell>
                <TableCell>{decimal(row[evidenceStage].mrr10)}</TableCell>
                <TableCell>{decimal(row[evidenceStage].map10)}</TableCell>
              </TableRow>)}
            </TableBody>
          </Table>
        </div>
        <div className="benchmark-table">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mode</TableHead>
                <TableHead>Question type</TableHead>
                <TableHead>Scored</TableHead>
                <TableHead>Overlap matches</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.flatMap(row => Object.entries(row.byType).map(([type, counts]) => <TableRow key={`${row.mode}-${type}`}>
                <TableHead>{modeLabels[row.mode]}</TableHead>
                <TableCell>{type}</TableCell>
                <TableCell>{counts.completed} / {job.questionTypeCounts[type]}</TableCell>
                <TableCell>{counts.passed}</TableCell>
              </TableRow>))}
            </TableBody>
          </Table>
        </div>
        <p><a href={`https://github.com/yixuantt/MultiHop-RAG/blob/${job.evaluatorCommit}/retrieval_evaluate.py`} target="_blank" rel="noreferrer">Official retrieval evaluator</a> · <a href={`https://github.com/yixuantt/MultiHop-RAG/blob/${job.evaluatorCommit}/qa_evaluate.py`} target="_blank" rel="noreferrer">Official answer evaluator</a></p>
      </details>
    </section>}

    {job && <section className="benchmark-questions" aria-labelledby="benchmark-questions-title">
      <header><div><h2 id="benchmark-questions-title">Individual questions</h2><p>Select a saved question to inspect answers, retrieved chunks, model inputs, costs, and charts for each mode.</p></div>
        <label><span className="sr-only">Filter benchmark questions</span><Input type="search" placeholder="Find a question" value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }} /></label>
      </header>
      {detailLoading && <p role="status">Opening saved question...</p>}
      <div className="benchmark-table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Question</TableHead>
              <TableHead>Type</TableHead>
              {selectedModes.map(mode => <TableHead key={mode}>{modeLabels[mode]}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {questions.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(question => {
              const summary = byQuestion.get(question.index);
              return <TableRow key={question.index}>
                <TableHead className="whitespace-normal">
                  <Button type="button" variant="link" className="benchmark-question-link h-auto p-0 text-left" disabled={!summary} onClick={() => void inspectQuestion(question.index)}>
                    <span>{question.index + 1}.</span>{question.query}
                  </Button>
                </TableHead>
                <TableCell>{question.questionType}</TableCell>
                {selectedModes.map(mode => {
                  const result = summary?.modes[mode];
                  return <TableCell key={mode}>{result?.phase ?? 'Pending'}{result?.score && <small>Overlap {result.score.answerOverlap ? 'match' : 'no match'}</small>}{result?.abstained && <small>Abstained</small>}{result && result.attempts > 1 && <small>{result.attempts} attempts</small>}</TableCell>;
                })}
              </TableRow>;
            })}
          </TableBody>
        </Table>
      </div>
      {!questions.length && <p>No questions match this filter.</p>}
      <div className="benchmark-pagination">
        <Button type="button" variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button>
        <span>Page {currentPage + 1} / {Math.max(1, Math.ceil(questions.length / PAGE_SIZE))}</span>
        <Button type="button" variant="outline" disabled={(currentPage + 1) * PAGE_SIZE >= questions.length} onClick={() => setPage(currentPage + 1)}>Next</Button>
      </div>
    </section>}
    {detail && job && <BenchmarkQuestionDetails key={`${job.id}:${detail.index}`} job={job} record={detail} onClose={() => { selectedQuestion.current = null; setDetail(null); }} />}
  </main>;
}
