import type { Candidate, ComparisonMode, ModelCall, Prompt, Ranked, Run, Settings } from './experiment';

export type BenchmarkQuestion = {
  index: number;
  query: string;
  answer: string;
  questionType: string;
  facts: string[];
};

export type RetrievalMetrics = {
  hits4: number;
  hits10: number;
  mrr10: number;
  map10: number;
};

export type BenchmarkScore = {
  answerOverlap: boolean;
  retrieval: RetrievalMetrics | null;
  selected: RetrievalMetrics | null;
};

export type BenchmarkAttempt = {
  run: Run;
  score: BenchmarkScore | null;
  usageIncomplete: boolean;
  errorCode?: string;
  prediction?: string;
  abstained?: boolean;
};

export type BenchmarkRetrieval = {
  candidates: Candidate[];
  ms: number;
  timings?: Record<string, number>;
};

export type BenchmarkRecord = {
  jobId: string;
  index: number;
  question: BenchmarkQuestion;
  retrieval?: BenchmarkRetrieval;
  attempts: BenchmarkAttempt[];
};

export type BenchmarkModeSummary = {
  phase: Run['phase'];
  settled: boolean;
  attempts: number;
  answer: string | null;
  prediction: string | null;
  abstained: boolean;
  error: string | null;
  score: BenchmarkScore | null;
  answerTokens: number | null;
  answerCost: number | null;
  answerCalled: boolean;
  tokens: number | null;
  cost: number;
  unreported: number;
  seconds: number | null;
};

export type BenchmarkSummary = {
  jobId: string;
  index: number;
  query: string;
  questionType: string;
  referenceAnswer: string;
  modes: Partial<Record<ComparisonMode, BenchmarkModeSummary>>;
};

export type BenchmarkManifest = {
  name: string;
  revision: string;
  articles: number;
  questions: number;
  questionFile: string;
  sha256: string;
  questionsSha256: string;
};

export type BenchmarkJob = {
  format: 'atlas-multihop-benchmark';
  version: 1;
  id: string;
  created: string;
  updated: string;
  status: 'ready' | 'running' | 'paused' | 'completed' | 'completed_with_errors' | 'error';
  modes: ComparisonMode[];
  settings: Settings;
  manifest: BenchmarkManifest;
  pipelineId: string;
  evaluatorCommit: string;
  modelNames: { jev: string; answer: string };
  questionTypeCounts: Record<string, number>;
  rates: Record<string, { input: number | null; cached: number | null; output: number | null }>;
  error?: string;
};

export type PipelineEvent =
  | { type: 'model-call'; call: ModelCall }
  | { type: 'searching'; progress: string }
  | { type: 'retrieved'; candidates: Candidate[]; searchTerms?: string[]; retrievalMs?: number; retrievalTimings?: Record<string, number> }
  | { type: 'ranking'; questions: Record<string, unknown> }
  | { type: 'relevance-progress'; completed: number; total: number }
  | { type: 'ranked'; ranked: Ranked[]; jevAnswers?: unknown; jevUsage?: unknown; jevMs?: number }
  | { type: 'selecting'; progress: string }
  | { type: 'selection-step'; decision: Ranked; check?: unknown }
  | { type: 'selected'; ranked: Ranked[]; context: Prompt; selection?: unknown[]; jevMs?: number }
  | { type: 'answering' }
  | { type: 'answer-delta'; delta: string }
  | { type: 'answer'; answer: string; skipped?: boolean; llmUsage?: unknown; llmMs?: number }
  | { type: 'error'; error: string; code?: string }
  | { type: 'keyword-attempt'; terms: string[]; matches: number };

export type BenchmarkProgress = {
  questionIndex: number;
  mode: ComparisonMode;
  stage: string;
};

export type BenchmarkDependencies = {
  retrieve: (question: string, signal: AbortSignal) => Promise<BenchmarkRetrieval>;
  generate: (
    mode: ComparisonMode,
    question: string,
    candidates: Candidate[],
    onEvent: (event: PipelineEvent) => void,
    signal: AbortSignal,
  ) => Promise<{ skipped?: boolean }>;
  load: (index: number) => Promise<BenchmarkRecord | undefined>;
  save: (record: BenchmarkRecord) => Promise<BenchmarkSummary>;
  summaries: () => Promise<BenchmarkSummary[]>;
  progress?: (progress: BenchmarkProgress) => void;
  saved?: (summary: BenchmarkSummary, record: BenchmarkRecord) => void;
};
