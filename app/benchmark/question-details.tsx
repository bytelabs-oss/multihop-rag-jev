'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Answer } from '../experiment-panels';
import { EvidenceSidebar, RunDetails } from '../run-details';
import { runLabel } from '../../lib/experiment';
import type { BenchmarkJob, BenchmarkRecord } from '../../lib/benchmark-types';

const originals = new Map<string, string>();
const noop = () => {};

export function BenchmarkQuestionDetails({
  job,
  record,
  onClose,
}: {
  job: BenchmarkJob;
  record: BenchmarkRecord;
  onClose: () => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const select = (event: Event) => setSelected((event as CustomEvent<string>).detail);
    window.addEventListener('atlas-select-chunk', select);
    return () => window.removeEventListener('atlas-select-chunk', select);
  }, []);

  const attempt = record.attempts.find(item => item.run.id === active)
    ?? record.attempts.filter(item => item.run.mode === job.modes[0]).at(-1)
    ?? record.attempts.at(-1);
  const run = attempt?.run;
  const runs = record.attempts.map(item => item.run);
  const current = run?.candidates.find(candidate => candidate.id === selected);

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent
        className="benchmark-question-dialog gap-0 p-0 sm:max-w-none"
        showCloseButton={false}
        onOpenAutoFocus={event => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <header>
          <div>
            <DialogTitle ref={titleRef} id="benchmark-question-title" tabIndex={-1}>
              Question {record.index + 1}
            </DialogTitle>
            <p>{record.question.query}</p>
          </div>
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
        </header>
        <nav className="benchmark-attempts" aria-label="Question modes and attempts">
          {record.attempts.map(item => <Button
            key={item.run.id}
            type="button"
            variant={run?.id === item.run.id ? 'secondary' : 'outline'}
            aria-pressed={run?.id === item.run.id}
            onClick={() => { setActive(item.run.id); setSelected(null); }}
          >
            {runLabel(item.run)}
            <small>{item.run.phase}</small>
          </Button>)}
        </nav>
        {!run ? <p className="benchmark-empty">This question has not started an answer mode yet.</p> :
          <div className="benchmark-question-body">
            <EvidenceSidebar
              docs={[]}
              showDocuments={false}
              run={run}
              current={current}
              selected={selected}
              filter={null}
              busy={false}
              originals={originals}
              onFilter={noop}
              onRemove={noop}
              onSelect={setSelected}
            />
            <div className="benchmark-question-main">
              <section className="benchmark-answer">
                <h3>{runLabel(run)} answer</h3>
                {run.answer ? <Answer text={run.answer} run={run} onSelect={noop} /> : <p>{run.error ?? 'This mode is still running. Its trace updates when the attempt finishes.'}</p>}
                {run.answer && run.phase !== 'done' && <p className="run-error">Partial answer. {run.error}</p>}
                {attempt?.usageIncomplete && <p className="run-error">This attempt has incomplete usage records. Its cost is not a final total.</p>}
                <details className="benchmark-reference">
                  <summary>Reference answer and scoring</summary>
                  <p className="usage-note">References are used only for local scoring, never for retrieval or answer generation.</p>
                  <h4>Reference answer</h4>
                  <p>{record.question.answer}</p>
                  <h4>Repository overlap score</h4>
                  <p>{attempt?.score ? attempt.score.answerOverlap ? 'At least one reference token matched.' : 'No reference tokens matched.' : 'Not scored. Only completed predictions receive a score.'}</p>
                  {attempt?.abstained && <p>The pipeline abstained. The scoring prediction is &quot;Insufficient information.&quot;</p>}
                  <p className="usage-note">This permissive score is not a semantic correctness judgment.</p>
                  <h4>Reference evidence</h4>
                  {record.question.facts.length ? <ul>{record.question.facts.map((fact, index) => <li key={index}>{fact}</li>)}</ul> : <p>This is an intentional no-answer question.</p>}
                </details>
              </section>
              <RunDetails
                key={run.id}
                run={run}
                runs={runs}
                initialRates={job.rates}
                readOnlyRates
                onSelectRun={id => { setActive(id); setSelected(null); }}
                onSelectChunk={setSelected}
              />
            </div>
          </div>}
      </DialogContent>
    </Dialog>
  );
}
