import {defaultRates,estimateCost} from './cost.mjs';
import {sumUsage} from './usage.mjs';
import {comparisonRow} from './comparison.mjs';

export const EVALUATOR_COMMIT='c1c1287aa60a94acf9c4d20c891c9cd611a0f6e8';
export const isCaseFailure=code=>['context_window','answer_incomplete'].includes(code);
const normalizeFact=text=>text.replace(/ |\n/g,'');
const words=text=>text.toLowerCase().split(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u).filter(Boolean);

/** @param {string[]} retrieved @param {string[]} facts @returns {import('./benchmark-types').RetrievalMetrics} */
export function scoreRetrieval(retrieved,facts){
 if(!facts.length)throw new Error('Retrieval scoring requires gold facts; exclude null queries.');
 const gold=facts.map(normalizeFact),found=new Set();
 let hits4=0,hits10=0,mrr10=0,sum=0;
 for(const [index,text] of retrieved.slice(0,10).entries()){
  const passage=normalizeFact(text),rank=index+1;
  if(!gold.some(fact=>passage.includes(fact)))continue;
  hits10=1;if(rank<=4)hits4=1;if(!mrr10)mrr10=1/rank;
  let newlyFound=0;
  for(const fact of gold)if(passage.includes(fact)&&!found.has(fact)){found.add(fact);newlyFound++;}
  sum+=newlyFound/rank;
 }
 // Preserve the repository's formula, which is not textbook average precision.
 return {hits4,hits10,mrr10,map10:sum/Math.min(gold.length,10)};
}

/** @param {string} prediction @param {string} reference */
export function scoreAnswer(prediction,reference){
 const extracted=prediction.match(/The answer to the question is "(.*?)"/)?.[1]??prediction;
 const predicted=new Set(words(extracted));
 return words(reference).some(word=>predicted.has(word));
}

/** @returns {import('./benchmark-types').BenchmarkQuestion[]} */
export function parseBenchmarkQuestions(value){
 if(!Array.isArray(value)||!value.length)throw new Error('The benchmark question file must be a nonempty array.');
 return value.map((item,index)=>{
  if(!item||typeof item.query!=='string'||!item.query.trim()||typeof item.answer!=='string'||!item.answer.trim()||
   !['inference_query','comparison_query','temporal_query','null_query'].includes(item.question_type)||!Array.isArray(item.evidence_list)){
   throw new Error(`Benchmark question ${index+1} is invalid.`);
  }
  const facts=item.evidence_list.map(evidence=>{
   if(typeof evidence?.fact!=='string'||!evidence.fact.trim())throw new Error(`Benchmark question ${index+1} has invalid evidence.`);
   return evidence.fact;
  });
  if(item.question_type!=='null_query'&&!facts.length)throw new Error(`Benchmark question ${index+1} has no reference evidence.`);
  return {index,query:item.query,answer:item.answer,questionType:item.question_type,facts};
 });
}

/** @param {import('./benchmark-types').BenchmarkQuestion} question @param {import('./experiment').Run} run @param {boolean} abstained @returns {import('./benchmark-types').BenchmarkScore} */
export function scoreRun(question,run,abstained=false){
 if(run.phase!=='done')throw new Error('Incomplete runs cannot receive benchmark scores.');
 const selected=run.ranked.filter(r=>r.kept).map(r=>{
  const candidate=run.candidates.find(c=>c.id===r.id);
  if(!candidate)throw new Error('Selected evidence is missing from the saved retrieval.');
  return candidate.text;
 });
 const prediction=abstained?'Insufficient information.':run.answer;
 if(typeof prediction!=='string'||!prediction.trim())throw new Error('A completed benchmark run needs a prediction.');
 return {
  answerOverlap:scoreAnswer(prediction,question.answer),
  retrieval:question.questionType==='null_query'?null:scoreRetrieval(run.candidates.map(c=>c.text),question.facts),
  selected:question.questionType==='null_query'?null:scoreRetrieval(selected,question.facts),
 };
}

/** @param {import('./benchmark-types').BenchmarkRecord} record @param {import('./benchmark-types').BenchmarkJob['rates']} rates @returns {import('./benchmark-types').BenchmarkSummary} */
export function summarizeQuestion(record,rates=defaultRates){
 /** @type {import('./benchmark-types').BenchmarkSummary['modes']} */
 const modes={};
 for(const mode of ['hybrid','jev','keyword','keyword-jev']){
  const attempts=record.attempts.filter(a=>a.run.mode===mode);
  const latest=attempts.at(-1);
  if(!latest)continue;
  const calls=attempts.flatMap(a=>a.run.calls??[]),cost=estimateCost(calls,rates),tokens=sumUsage(calls).total;
  const incomplete=attempts.some(a=>a.usageIncomplete);
  const answer=comparisonRow(latest.run,rates);
  modes[mode]={
   phase:latest.run.phase,settled:latest.run.phase==='done'||(latest.run.phase==='error'&&isCaseFailure(latest.errorCode)),
   attempts:attempts.length,answer:latest.run.answer??null,prediction:latest.prediction??null,abstained:!!latest.abstained,error:latest.run.error??null,
   score:latest.score,answerCalled:answer.answerCalled,
   answerTokens:!answer.answerCalled&&latest.run.phase==='done'?0:answer.answerTokens,
   answerCost:!answer.answerCalled&&latest.run.phase==='done'?0:answer.answerCost,
   tokens:tokens.missing||incomplete?null:tokens.value,cost:cost.usd,
   unreported:cost.missing+attempts.filter(a=>a.usageIncomplete).length,
   seconds:latest.run.elapsedMs==null?null:latest.run.elapsedMs/1000,
  };
 }
 return {jobId:record.jobId,index:record.index,query:record.question.query,questionType:record.question.questionType,referenceAnswer:record.question.answer,modes};
}

/** @param {import('./benchmark-types').BenchmarkJob} job @param {import('./benchmark-types').BenchmarkSummary[]} summaries */
export function summarizeBenchmark(job,summaries){
 if(new Set(summaries.map(s=>s.index)).size!==summaries.length)throw new Error('Duplicate benchmark question results.');
 if(summaries.some(s=>s.jobId!==job.id||!Number.isInteger(s.index)||s.index<0||s.index>=job.manifest.questions))throw new Error('Results do not belong to this benchmark.');
 return job.modes.map(mode=>{
  const rows=summaries.flatMap(s=>s.modes[mode]?[{type:s.questionType,result:s.modes[mode]}]:[]);
  const complete=rows.filter(row=>row.result.phase==='done'&&row.result.score!==null);
  const retrieval=complete.filter(row=>row.result.score.retrieval!==null);
  const mean=(key,stage)=>retrieval.length?retrieval.reduce((sum,row)=>sum+row.result.score[stage][key],0)/retrieval.length:null;
  return {
   mode,total:job.manifest.questions,completed:complete.length,
   failed:rows.filter(row=>['error','cancelled'].includes(row.result.phase)).length,
   full:complete.length===job.manifest.questions,
   answerOverlap:complete.length?complete.filter(row=>row.result.score.answerOverlap).length/complete.length:null,
   answerTokens:complete.some(row=>row.result.answerTokens===null)?null:complete.reduce((sum,row)=>sum+row.result.answerTokens,0),
   answerCost:complete.some(row=>row.result.answerCost===null)?null:complete.reduce((sum,row)=>sum+row.result.answerCost,0),
   answerCalls:complete.filter(row=>row.result.answerCalled).length,
   retrievalCount:retrieval.length,
   retrieval:{hits4:mean('hits4','retrieval'),hits10:mean('hits10','retrieval'),mrr10:mean('mrr10','retrieval'),map10:mean('map10','retrieval')},
   selected:{hits4:mean('hits4','selected'),hits10:mean('hits10','selected'),mrr10:mean('mrr10','selected'),map10:mean('map10','selected')},
   cost:rows.reduce((sum,row)=>sum+row.result.cost,0),
   unreported:rows.reduce((sum,row)=>sum+row.result.unreported,0),
   tokens:rows.some(row=>row.result.tokens===null)?null:rows.reduce((sum,row)=>sum+row.result.tokens,0),
   byType:Object.fromEntries(['inference_query','comparison_query','temporal_query','null_query'].map(type=>{
    const typed=complete.filter(row=>row.type===type);
    return [type,{completed:typed.length,passed:typed.filter(row=>row.result.score.answerOverlap).length}];
   })),
  };
 });
}
