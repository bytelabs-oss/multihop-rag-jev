'use client';

import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { runLabel, type Run } from '../lib/experiment';
import { comparisonRow } from '../lib/comparison.mjs';
import { scoreAnswer } from '../lib/benchmark-metrics.mjs';
import { formatCost } from '../lib/cost.mjs';

type Rates = Record<string, { input: number | null; cached: number | null; output: number | null }>;
type ComparisonRow = ReturnType<typeof comparisonRow>;
type ChartMetric = 'answerTokens' | 'answerCost' | 'totalTokens' | 'cost' | 'seconds' | 'retrieved' | 'kept' | 'jevCost' | 'gptCost' | 'jevRatePerMtok' | 'gptRatePerMtok';

const number = (n: number | null) => n == null ? 'Unreported' : n.toLocaleString();
const dollars = (n: number | null) => n == null ? 'Unreported' : formatCost({ usd: n, missing: 0, count: 1 });
const colors = ['#c7dc9c', '#80b8ce', '#dfa578', '#c2a7db'];

function answerCell(row: ComparisonRow, metric: 'answerTokens' | 'answerCost', format: (n: number | null) => string) {
  if (row.answerCalled) return format(row[metric]);
  return ['done', 'error', 'cancelled'].includes(row.run.phase) ? 'Not called' : 'Pending';
}

function chartData(rows: ComparisonRow[], series: { key: ChartMetric; label: string }[], answerOnly: boolean) {
  return rows.map(row => {
    const ready = row.complete && (!answerOnly || row.answerCalled);
    const status = row.complete && answerOnly && !row.answerCalled ? 'Not called' : row.run.phase;
    const entry: Record<string, unknown> = { mode: runLabel(row.run), status };
    for (const item of series) entry[item.key] = ready ? row[item.key] : null;
    return entry;
  });
}

function Chart({
  title,
  rows,
  series,
  format,
  answerOnly = false,
  stacked = false,
}: {
  title: string;
  rows: ComparisonRow[];
  series: { key: ChartMetric; label: string }[];
  format: (n: number | null) => string;
  answerOnly?: boolean;
  stacked?: boolean;
}) {
  const data = chartData(rows, series, answerOnly);
  const height = Math.max(140, rows.length * (series.length > 1 && !stacked ? 64 : 44) + 40);

  return <section className="result-chart">
    <h3>{title}</h3>
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tickFormatter={value => format(value)} stroke="var(--muted)" fontSize={11} tickLine={false} />
          <YAxis type="category" dataKey="mode" width={130} stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} />
          <Tooltip
            cursor={{ fill: 'var(--line)', opacity: 0.35 }}
            contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 4, fontSize: 12, color: 'var(--text)' }}
            formatter={(value, name, item) => [typeof value === 'number' ? format(value) : ((item?.payload as { status?: string })?.status ?? 'Unreported'), String(name)] as [string, string]}
          />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: 'var(--muted)' }} />}
          {series.map((item, index) => (
            <Bar
              key={item.key}
              dataKey={item.key}
              name={item.label}
              fill={colors[index % colors.length]}
              radius={stacked ? [0, 0, 0, 0] : [0, 3, 3, 0]}
              maxBarSize={18}
              stackId={stacked ? 'stack' : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
    <div className="sr-only">
      <Table>
        <TableCaption>{title}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Mode</TableHead>
            {series.map(item => <TableHead key={item.key}>{item.label}</TableHead>)}
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={row.run.id}>
              <TableHead>{runLabel(row.run)}</TableHead>
              {series.map(item => <TableCell key={item.key}>{format(data[index][item.key] as number | null)}</TableCell>)}
              <TableCell>{data[index].status as string}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
    <p className="chart-scale">Bars start at zero. {answerOnly ? 'Runs without a completed GPT answer are not plotted.' : 'Incomplete runs are not plotted.'}</p>
  </section>;
}

function answerMatch(row: ComparisonRow): 'correct' | 'wrong' | 'unscored' {
  const reference = row.run.referenceAnswer;
  if (!reference || row.run.phase !== 'done' || !row.run.answer) return 'unscored';
  return scoreAnswer(row.run.answer, reference) ? 'correct' : 'wrong';
}

function CorrectnessBadge({ row }: { row: ComparisonRow }) {
  const match = answerMatch(row);
  if (match === 'unscored') {
    return <Badge variant="secondary" className="border-transparent bg-[var(--line)] text-muted-foreground">No reference</Badge>;
  }
  return <Badge
    variant="outline"
    className={match === 'correct'
      ? 'border-[#35693f] bg-[#1f4d2c] text-[#9be5a8]'
      : 'border-[#7a4040] bg-[#4d1f1f] text-[#e59b9b]'}
  >
    {match === 'correct' ? 'Correct' : 'Wrong'}
  </Badge>;
}

export function ComparisonDialog({
  runs,
  initialGroup,
  rates,
  onClose,
  onInspect,
}: {
  runs: Run[];
  initialGroup: string;
  rates: Rates;
  onClose: () => void;
  onInspect: (id: string) => void;
}) {
  const [group, setGroup] = useState(initialGroup);
  const [view, setView] = useState<'metrics' | 'answers'>('metrics');
  const groups = [...new Map(runs.map(run => [run.groupId, run.question])).entries()];
  const selected = runs.filter(run => run.groupId === group);
  const rows = selected.map(run => comparisonRow(run, rates));
  const rateRatios = rows.filter(row => row.jevRatePerMtok && row.gptRatePerMtok).map(row => row.gptRatePerMtok! / row.jevRatePerMtok!);
  const rateRatio = rateRatios.length ? rateRatios.reduce((sum, value) => sum + value, 0) / rateRatios.length : null;

  function download() {
    const payload = {
      question: selected[0]?.question,
      referenceAnswer: selected[0]?.referenceAnswer ?? null,
      ratesUsdPerMillion: rates,
      results: rows.map(row => {
        const { run, ...metrics } = row;
        return {
          ...metrics,
          mode: runLabel(run),
          status: run.phase,
          answer: run.answer,
          error: run.error,
          retryOf: run.retryOf,
          settings: run.settings,
          answerMatch: run.referenceAnswer ? answerMatch(row) : null,
        };
      }),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'atlas-comparison.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="comparison-dialog gap-0 p-7 sm:max-w-none" showCloseButton={false}>
        <header>
          <div>
            <DialogTitle id="comparison-title">Compare results</DialogTitle>
            <p>{selected.length} runs for this question</p>
          </div>
          <Button type="button" variant="outline" onClick={onClose} aria-label="Close comparison">Close</Button>
        </header>
        <label className="comparison-question">
          <span>Question</span>
          <NativeSelect value={group} onChange={event => setGroup(event.target.value)}>
            {groups.map(([id, question], index) => (
              <NativeSelectOption key={id} value={id}>
                {index + 1}. {question}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <p className="comparison-question-text">{selected[0]?.question}</p>
        {selected[0]?.referenceAnswer && <p className="comparison-reference-answer">Reference answer: <strong>{selected[0].referenceAnswer}</strong></p>}
        <nav aria-label="Comparison view">
          <Button type="button" variant="ghost" aria-pressed={view === 'metrics'} onClick={() => setView('metrics')}>Table & charts</Button>
          <Button type="button" variant="ghost" aria-pressed={view === 'answers'} onClick={() => setView('answers')}>Answers side by side</Button>
          <Button type="button" variant="ghost" className="comparison-export" onClick={download}>Export results</Button>
        </nav>
        {view === 'metrics' ? <>
          <div className="comparison-data">
            <Table className="usage-table">
              <TableCaption>GPT answer metrics cover the shared generation step. Whole-run totals include every model call. Costs are USD estimates at the current rates.</TableCaption>
              <TableHeader>
                <TableRow>
                  {['Mode', 'Status', 'Retrieved', 'Kept', 'GPT answer tokens', 'GPT answer cost', 'Total tokens', 'Total cost', 'Elapsed', 'Correct?'].map(header => (
                    <TableHead key={header}>{header}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(row => (
                  <TableRow key={row.run.id}>
                    <TableHead className="align-top whitespace-normal">
                      <Button type="button" variant="link" className="h-auto p-0 text-left font-medium" onClick={() => onInspect(row.run.id)}>
                        {runLabel(row.run)}
                      </Button>
                      {row.run.retryOf && <small>Includes first attempt</small>}
                    </TableHead>
                    <TableCell>{row.run.phase}</TableCell>
                    <TableCell>{row.retrieved}</TableCell>
                    <TableCell>{row.kept == null ? 'Pending' : row.kept}</TableCell>
                    <TableCell>{answerCell(row, 'answerTokens', number)}</TableCell>
                    <TableCell>{answerCell(row, 'answerCost', dollars)}</TableCell>
                    <TableCell>{number(row.totalTokens)}</TableCell>
                    <TableCell>{dollars(row.cost)}</TableCell>
                    <TableCell>{row.seconds == null ? 'Pending' : `${row.seconds.toFixed(2)}s`}</TableCell>
                    <TableCell><CorrectnessBadge row={row} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="comparison-section-heading">
            <h3>GPT answer only</h3>
            <p>Compare the same answer-generation step across modes. This excludes JEV, keyword planning, and query rewriting.</p>
          </div>
          <div className="comparison-charts">
            <Chart title="GPT answer cost · USD" rows={rows} series={[{ key: 'answerCost', label: 'GPT answer cost' }]} format={dollars} answerOnly />
            <Chart title="GPT answer tokens" rows={rows} series={[{ key: 'answerTokens', label: 'Input and output tokens' }]} format={number} answerOnly />
          </div>
          <div className="comparison-section-heading">
            <h3>Whole run</h3>
            <p>Compare total cost, tokens, and elapsed time. Totals include JEV and any additional GPT planning or rewrite calls used by that mode.</p>
          </div>
          <div className="comparison-charts">
            <Chart title="Total cost · USD" rows={rows} series={[{ key: 'cost', label: 'Total cost' }]} format={dollars} />
            <Chart title="Total tokens" rows={rows} series={[{ key: 'totalTokens', label: 'Total tokens' }]} format={number} />
            <Chart title="Total elapsed time" rows={rows} series={[{ key: 'seconds', label: 'Seconds' }]} format={value => value == null ? 'Unreported' : `${value.toFixed(2)}s`} />
            <Chart title="Evidence selection" rows={rows} series={[{ key: 'retrieved', label: 'Retrieved' }, { key: 'kept', label: 'Kept' }]} format={number} />
          </div>
          <div className="comparison-section-heading">
            <h3>Cost by engine</h3>
            <p>JEV and GPT are priced very differently per token. JEV output tokens are free, and its input rate is far below GPT input rates, so a mode JEV token count can dwarf its GPT token count while still costing less. Each bar below is stacked JEV cost on top of GPT cost, and the full bar height is that mode total cost.{rateRatio != null && ` GPT tokens cost about ${rateRatio < 10 ? rateRatio.toFixed(1) : Math.round(rateRatio)}x more per token than JEV tokens here.`}</p>
          </div>
          <div className="comparison-charts">
            <Chart title="Cost by engine · USD" rows={rows} series={[{ key: 'gptCost', label: 'GPT cost' }, { key: 'jevCost', label: 'JEV cost' }]} format={dollars} stacked />
          </div>
          <p className="comparison-note">Token counts are not dollar costs. These metrics do not measure answer accuracy. An answer that was not generated is marked Not called, not treated as a free completed answer. Retry rows include the first attempt and should not be added to that attempt again. Select a mode to inspect its own model breakdown.</p>
        </> : <div className="comparison-answers" style={{ gridTemplateColumns: `repeat(${Math.max(1, selected.length)},minmax(320px,1fr))` }}>
          {selected.map(run => <article key={run.id}>
            <header>
              <h3>{runLabel(run)}</h3>
              <span>{run.phase}</span>
              {run.referenceAnswer && <CorrectnessBadge row={{ run } as ComparisonRow} />}
            </header>
            <div>{run.answer || run.error || 'No answer yet.'}</div>
            {run.answer && run.phase !== 'done' && <p>Partial answer · {run.error || run.phase}</p>}
            <Button type="button" variant="link" className="h-auto p-0" onClick={() => onInspect(run.id)}>
              Inspect citations & inputs
            </Button>
          </article>)}
        </div>}
      </DialogContent>
    </Dialog>
  );
}
