import manifest from '../public/datasets/multihop-rag/manifest.json';
import { articleId, cachePayload, PIPELINE_ID, savedDocument, saveDocument, validateCache } from './cache.mjs';
import { parseCorpus } from './corpus.mjs';
import { EVALUATOR_COMMIT, parseBenchmarkQuestions } from './benchmark-metrics.mjs';
import { generationRequest } from './benchmark-runner.mjs';
import { localDocuments } from './local-documents';
import { streamExperiment } from './stream-experiment';
import { defaultRates } from './cost.mjs';
import { defaultSettings, type ComparisonMode, type Settings } from './experiment';
import type { Chunk, Doc } from './documents';
import type { BenchmarkDependencies, BenchmarkJob, BenchmarkManifest, BenchmarkQuestion } from './benchmark-types';
import { getBenchmarkQuestion, listBenchmarkSummaries, saveBenchmarkQuestion } from './benchmark-store';

export type BenchmarkDataset = {
  manifest: BenchmarkManifest;
  articles: ReturnType<typeof parseCorpus>;
  questions: BenchmarkQuestion[];
};

async function checkedFile(name: string, expectedHash: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`/datasets/multihop-rag/${name}`, { signal });
  if (!response.ok) throw new Error(`Could not load benchmark file ${name}.`);
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== expectedHash) throw new Error(`${name} does not match the pinned benchmark manifest.`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function loadBenchmarkDataset(signal?: AbortSignal): Promise<BenchmarkDataset> {
  const [corpus, questionFile] = await Promise.all([
    checkedFile('corpus.json', manifest.sha256, signal),
    checkedFile(manifest.questionFile, manifest.questionsSha256, signal),
  ]);
  const articles = parseCorpus(corpus);
  const questions = parseBenchmarkQuestions(questionFile);
  if (articles.length !== manifest.articles || questions.length !== manifest.questions) {
    throw new Error('The benchmark files are incomplete.');
  }
  return { manifest, articles, questions };
}

export function createBenchmarkJob(
  dataset: BenchmarkDataset,
  modes: ComparisonMode[],
  settings: Pick<Settings, 'topK' | 'threshold'>,
  modelNames: BenchmarkJob['modelNames'],
): BenchmarkJob {
  if (!modes.length || new Set(modes).size !== modes.length || modes.some(mode => !['hybrid', 'jev', 'keyword', 'keyword-jev'].includes(mode))) throw new Error('Choose valid benchmark modes.');
  if (!Number.isInteger(settings.topK) || settings.topK < 10) throw new Error('The benchmark needs at least 10 maximum candidates for its rank-10 metrics.');
  if (!Number.isFinite(settings.threshold) || settings.threshold < 0 || settings.threshold > 1) throw new Error('JEV relevance must be between 0 and 1.');
  const created = new Date().toISOString();
  const questionTypeCounts: Record<string, number> = {};
  for (const question of dataset.questions) questionTypeCounts[question.questionType] = (questionTypeCounts[question.questionType] ?? 0) + 1;
  return {
    format: 'atlas-multihop-benchmark', version: 1, id: crypto.randomUUID(), created, updated: created, status: 'ready',
    modes: [...modes], settings: { ...defaultSettings, ...settings, retryOnEmpty: false },
    manifest: dataset.manifest, pipelineId: PIPELINE_ID, evaluatorCommit: EVALUATOR_COMMIT,
    modelNames, questionTypeCounts, rates: structuredClone(defaultRates),
  };
}

export function assertBenchmarkCompatible(job: BenchmarkJob, dataset: BenchmarkDataset, models: BenchmarkJob['modelNames']) {
  if (job.pipelineId !== PIPELINE_ID || job.evaluatorCommit !== EVALUATOR_COMMIT ||
      job.manifest.sha256 !== dataset.manifest.sha256 || job.manifest.questionsSha256 !== dataset.manifest.questionsSha256 ||
      job.manifest.articles !== dataset.manifest.articles || job.manifest.questions !== dataset.manifest.questions) {
    throw new Error('The dataset or pipeline has changed since this run. Start a new benchmark.');
  }
  if (!job.modes.length || new Set(job.modes).size !== job.modes.length || job.modes.some(mode => !['hybrid', 'jev', 'keyword', 'keyword-jev'].includes(mode)) ||
      !Number.isInteger(job.settings.topK) || job.settings.topK < 10 ||
      !Number.isFinite(job.settings.threshold) || job.settings.threshold < 0 || job.settings.threshold > 1 ||
      !Number.isFinite(job.settings.semanticThreshold) || job.settings.semanticThreshold < -1 || job.settings.semanticThreshold > 1 ||
      job.settings.retryOnEmpty) {
    throw new Error('The saved benchmark configuration is invalid. Start a new benchmark.');
  }
  if (job.modelNames.answer !== models.answer || ((job.modes.includes('jev') || job.modes.includes('keyword-jev')) && job.modelNames.jev !== models.jev)) {
    throw new Error('The configured models differ from this saved run. Start a new benchmark.');
  }
}

export async function prepareBenchmarkCorpus(
  dataset: BenchmarkDataset,
  progress: (done: number, total: number, message: string) => void,
  signal: AbortSignal,
): Promise<Doc[]> {
  const documents: Doc[] = [];
  for (const article of dataset.articles) {
    signal.throwIfAborted();
    const id = await articleId(article);
    const cached = await savedDocument(id);
    if (cached) {
      const [document] = validateCache(cachePayload([cached]));
      documents.push(document);
      progress(documents.length, dataset.articles.length, 'Reusing saved dataset embeddings');
      continue;
    }
    progress(documents.length, dataset.articles.length, `Processing ${article.title}`);
    const result = await localDocuments({ mode: 'ingest-article', article }, message =>
      progress(documents.length, dataset.articles.length, message), signal);
    if (!Array.isArray(result.chunks) || !result.chunks.length) throw new Error('Document processing returned no benchmark chunks.');
    const document: Doc = {
      id, name: article.title.slice(0, 250), size: new Blob([article.body]).size, count: result.chunks.length,
      created: new Date().toISOString(), body: article.body,
      chunks: result.chunks.map((chunk: Chunk, index: number) => ({ ...chunk, id: `${id}:${index}` })),
    };
    validateCache(cachePayload([document]));
    await saveDocument(document);
    documents.push(document);
    progress(documents.length, dataset.articles.length, 'Dataset article saved');
  }
  signal.throwIfAborted();
  return documents;
}

export function benchmarkDependencies(
  job: BenchmarkJob,
  documents: Doc[],
  updates: Pick<BenchmarkDependencies, 'progress' | 'saved'>,
): BenchmarkDependencies {
  const chunks = documents.flatMap(doc => doc.chunks.map(chunk => ({ ...chunk, docId: doc.id, docName: doc.name })));
  const corpusKey = `benchmark:${job.manifest.sha256}:${job.pipelineId}`;
  return {
    ...updates,
    retrieve: async (question, signal) => {
      const started = performance.now();
      const result = await localDocuments({
        mode: 'search', corpusKey, chunks, question,
        topK: job.settings.topK, semanticThreshold: job.settings.semanticThreshold,
      }, () => {}, signal);
      if (!Array.isArray(result.candidates)) throw new Error('The benchmark retrieval response is incomplete.');
      return { candidates: result.candidates, timings: result.timings, ms: performance.now() - started };
    },
    generate: (mode, question, candidates, onEvent, signal) =>
      streamExperiment(generationRequest(mode, question, job.settings, candidates), onEvent, signal),
    load: index => getBenchmarkQuestion(job.id, index),
    save: record => saveBenchmarkQuestion(record, job.rates),
    summaries: () => listBenchmarkSummaries(job.id),
  };
}
