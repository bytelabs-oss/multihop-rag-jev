'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, Search, Shuffle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { buildQuestionCatalogue, questionsForDocuments, selectItems } from '../lib/corpus.mjs';
import type { Doc } from '../lib/documents';

const PAGE_SIZE = 20;

export const DatasetQuestions = memo(function DatasetQuestions({
  onChoose,
  disabled,
  documents,
}: {
  onChoose: (question: string, answer: string) => void;
  disabled: boolean;
  documents: readonly Pick<Doc, 'id'>[];
}) {
  const [catalogue, setCatalogue] = useState<Awaited<ReturnType<typeof buildQuestionCatalogue>>>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [exampleCount, setExampleCount] = useState(10);
  const [seed, setSeed] = useState(42);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(false);
  const request = useRef<AbortController | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);

  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    if (open) searchInput.current?.focus();
  }, [open]);

  async function loadQuestions() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setStatus('loading');
    setError('');
    try {
      const [questionResponse, corpusResponse] = await Promise.all([
        fetch('/datasets/multihop-rag/MultiHopRAG.json', { signal: controller.signal }),
        fetch('/datasets/multihop-rag/corpus.json', { signal: controller.signal }),
      ]);
      if (!questionResponse.ok) throw new Error('Could not load MultiHopRAG.json. Retry or restore the question file.');
      if (!corpusResponse.ok) throw new Error('Could not load corpus.json to match questions to your articles. Retry loading.');
      const [questionFile, corpusFile] = await Promise.all([questionResponse.json(), corpusResponse.json()]);
      const next = await buildQuestionCatalogue(questionFile, corpusFile);
      if (!controller.signal.aborted) {
        setCatalogue(next);
        setStatus('ready');
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Could not read the question file.');
        setStatus('error');
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  function openBrowser() {
    setOpen(true);
    if (status === 'idle') void loadQuestions();
  }

  function showPage(next: number) {
    setPage(next);
    results.current?.scrollTo({ top: 0 });
  }

  function chooseQuestion(question: string, answer: string) {
    setOpen(false);
    onChoose(question, answer);
  }

  const questions = useMemo(() => questionsForDocuments(catalogue, documents), [catalogue, documents]);
  const searching = filter.trim().length > 0;
  const matches = useMemo(() => {
    const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return questions.filter(({ question }) => terms.every(term => question.toLowerCase().includes(term)));
  }, [questions, filter]);
  const examples = useMemo(
    () => searching || exampleCount === 0 ? matches : selectItems(matches, exampleCount, 'random', seed),
    [matches, searching, exampleCount, seed],
  );
  const pageCount = Math.max(1, Math.ceil(examples.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = examples.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return <>
    <Button type="button" variant="outline" className="browse-questions" disabled={disabled} aria-haspopup="dialog" onClick={openBrowser}>
      <BookOpen size={16} aria-hidden="true" />
      Browse dataset questions
      <ChevronRight size={16} aria-hidden="true" />
    </Button>
    <Dialog open={open} onOpenChange={next => setOpen(next)}>
      <DialogContent
        className="question-browser gap-0 p-0 sm:max-w-none"
        showCloseButton={false}
        onOpenAutoFocus={event => {
          event.preventDefault();
          searchInput.current?.focus();
        }}
      >
        <DialogHeader className="question-browser-header text-left">
          <div>
            <DialogTitle id="question-browser-title">Choose a question</DialogTitle>
            <DialogDescription id="question-browser-description">
              Only questions whose source articles are all loaded appear here.
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button type="button" variant="ghost" size="icon" className="question-browser-close" aria-label="Close question browser">
              <X size={20} aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        <div className="question-browser-tools">
          <label className="question-browser-search">
            <Search size={18} aria-hidden="true" />
            <Input
              ref={searchInput}
              type="search"
              aria-label="Search dataset questions"
              placeholder="Search questions for your loaded articles"
              value={filter}
              disabled={disabled}
              onChange={event => { setFilter(event.target.value); showPage(0); }}
            />
          </label>
          <div className="question-browser-set">
            <label>
              <span>Example set</span>
              <NativeSelect
                aria-label="Example set size"
                value={String(exampleCount)}
                disabled={disabled || searching || status !== 'ready' || !questions.length}
                onChange={event => { setExampleCount(Number(event.target.value)); showPage(0); }}
              >
                <NativeSelectOption value={10}>10 questions</NativeSelectOption>
                <NativeSelectOption value={25}>25 questions</NativeSelectOption>
                <NativeSelectOption value={50}>50 questions</NativeSelectOption>
                <NativeSelectOption value={0}>All questions</NativeSelectOption>
              </NativeSelect>
            </label>
            <Button
              type="button"
              variant="ghost"
              className="question-browser-shuffle"
              disabled={disabled || searching || status !== 'ready' || exampleCount === 0 || questions.length <= exampleCount}
              onClick={() => { setSeed(value => (value + 1) >>> 0); showPage(0); }}
            >
              <Shuffle size={15} aria-hidden="true" />
              New examples
            </Button>
          </div>
          <p className="question-browser-scope">
            {status === 'ready'
              ? `${questions.length.toLocaleString()} answerable questions have all their sources loaded.${searching ? ' Search covers this whole set.' : ' Choosing one only fills the chat input.'}`
              : 'Questions are matched to the articles currently loaded, not the example-set size.'}
          </p>
        </div>

        <div ref={results} className="question-browser-results" aria-busy={status === 'loading'}>
          {status === 'loading' && <p className="question-browser-state" role="status">Loading dataset questions...</p>}
          {status === 'error' && <div className="question-browser-state">
            <p role="alert">{error}</p>
            <Button type="button" onClick={loadQuestions}>Retry loading</Button>
          </div>}
          {status === 'ready' && !questions.length && <div className="question-browser-state">
            <h3>No fully supported questions yet</h3>
            <p>Use Load MultiHop-RAG to load articles. Examples appear only when all their source articles are loaded. Intentional no-answer questions are excluded.</p>
          </div>}
          {status === 'ready' && questions.length > 0 && !examples.length && <div className="question-browser-state">
            <h3>No matching questions</h3>
            <p>Try another topic or clear the search to see examples.</p>
            <Button type="button" onClick={() => { setFilter(''); showPage(0); searchInput.current?.focus(); }}>Clear search</Button>
          </div>}
          {status === 'ready' && examples.length > 0 && <ul className="question-browser-list">
            {visible.map(({ question, answer, index }) => <li key={index}>
              <Button type="button" variant="ghost" className="question-option" disabled={disabled} onClick={() => chooseQuestion(question, answer)}>
                <span className="question-option-text">{question}</span>
                <span className="question-option-action">Use question <ArrowUpRight size={16} aria-hidden="true" /></span>
              </Button>
            </li>)}
          </ul>}
        </div>

        <footer className="question-browser-footer">
          <div className="question-browser-count">
            <p role="status">{status === 'ready' && (examples.length
              ? `Showing ${currentPage * PAGE_SIZE + 1} to ${Math.min((currentPage + 1) * PAGE_SIZE, examples.length)} of ${examples.length.toLocaleString()} ${searching ? 'matches' : 'questions'}`
              : questions.length ? 'No matching questions' : 'No questions have all their sources loaded')}</p>
            <a href="/datasets/multihop-rag/MultiHopRAG.json" download>Dataset source JSON</a>
          </div>
          {status === 'ready' && pageCount > 1 && <nav aria-label="Question pages" className="question-browser-pages">
            <Button type="button" variant="outline" disabled={currentPage === 0} onClick={() => showPage(currentPage - 1)}>
              <ChevronLeft size={16} aria-hidden="true" />
              Previous
            </Button>
            <span>{currentPage + 1} / {pageCount}</span>
            <Button type="button" variant="outline" disabled={currentPage + 1 === pageCount} onClick={() => showPage(currentPage + 1)}>
              Next
              <ChevronRight size={16} aria-hidden="true" />
            </Button>
          </nav>}
        </footer>
      </DialogContent>
    </Dialog>
  </>;
});
