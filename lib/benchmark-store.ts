import { summarizeQuestion } from './benchmark-metrics.mjs';
import type { BenchmarkJob, BenchmarkRecord, BenchmarkSummary } from './benchmark-types';

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('atlas-benchmarks', 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore('jobs', { keyPath: 'id' });
      for (const name of ['questions', 'summaries']) {
        request.result.createObjectStore(name, { keyPath: ['jobId', 'index'] }).createIndex('jobId', 'jobId');
      }
    };
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('Benchmark storage is blocked by another tab. Close that tab and retry.')); };
  });
}

async function read<T>(store: string, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(store, 'readonly');
      const request = action(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Benchmark storage read was interrupted.'));
    });
  } finally {
    db.close();
  }
}

async function write(stores: string[], action: (transaction: IDBTransaction) => void): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(stores, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Benchmark progress could not be saved.'));
      try {
        action(transaction);
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  } finally {
    db.close();
  }
}

export async function saveBenchmarkJob(job: BenchmarkJob): Promise<void> {
  await write(['jobs'], transaction => transaction.objectStore('jobs').put(job));
}

export async function listBenchmarkJobs(): Promise<BenchmarkJob[]> {
  const jobs = await read<BenchmarkJob[]>('jobs', store => store.getAll());
  if (jobs.some(job => !job || job.format !== 'atlas-multihop-benchmark' || job.version !== 1 ||
      !Array.isArray(job.modes) || !job.manifest || !job.settings || !job.rates || !job.modelNames || !job.questionTypeCounts)) {
    throw new Error('Saved benchmark data has an unsupported format.');
  }
  return jobs.sort((a, b) => b.created.localeCompare(a.created));
}

export async function listBenchmarkSummaries(jobId: string): Promise<BenchmarkSummary[]> {
  const rows = await read<BenchmarkSummary[]>('summaries', store => store.index('jobId').getAll(jobId));
  return rows.sort((a, b) => a.index - b.index);
}

export async function saveBenchmarkQuestion(
  record: BenchmarkRecord,
  rates: BenchmarkJob['rates'],
): Promise<BenchmarkSummary> {
  if (typeof CompressionStream === 'undefined') throw new Error('This browser cannot compress benchmark traces. Use a current browser.');
  const blob = await new Response(
    new Blob([JSON.stringify(record)]).stream().pipeThrough(new CompressionStream('gzip')),
  ).blob();
  const summary = summarizeQuestion(record, rates);
  await write(['questions', 'summaries'], transaction => {
    transaction.objectStore('questions').put({ jobId: record.jobId, index: record.index, blob });
    transaction.objectStore('summaries').put(summary);
  });
  return summary;
}

export async function getBenchmarkQuestion(jobId: string, index: number): Promise<BenchmarkRecord | undefined> {
  const saved = await read<{ jobId: string; index: number; blob: Blob } | undefined>(
    'questions', store => store.get([jobId, index]),
  );
  if (!saved) return undefined;
  if (!(saved.blob instanceof Blob) || typeof DecompressionStream === 'undefined') {
    throw new Error('This saved question trace cannot be opened in this browser.');
  }
  const text = await new Response(saved.blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const record: BenchmarkRecord = JSON.parse(text);
  if (record.jobId !== jobId || record.index !== index || !record.question ||
      !Array.isArray(record.attempts) || typeof record.question.query !== 'string') {
    throw new Error('The saved question trace does not match this benchmark.');
  }
  return record;
}
