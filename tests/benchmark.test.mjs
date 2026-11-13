import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {defaultRates} from '../lib/cost.mjs';
import {benchmarkChunks,executeBenchmark,generationRequest} from '../lib/benchmark-runner.mjs';
import {parseBenchmarkQuestions,scoreAnswer,scoreRetrieval,scoreRun,summarizeBenchmark,summarizeQuestion} from '../lib/benchmark-metrics.mjs';

test('retrieval scoring preserves official rank cutoffs and nonstandard MAP',()=>{
 assert.deepEqual(scoreRetrieval(['alpha','beta'],['alpha','beta']),{hits4:1,hits10:1,mrr10:1,map10:.75});
 assert.deepEqual(scoreRetrieval(['ALPHA'],['alpha']),{hits4:0,hits10:0,mrr10:0,map10:0});
 assert.deepEqual(scoreRetrieval(['a\n b'],['ab']),{hits4:1,hits10:1,mrr10:1,map10:1});
 assert.equal(scoreRetrieval(['a\tb'],['ab']).hits10,0);
 assert.deepEqual(scoreRetrieval([...Array(4).fill('irrelevant'),'alpha'],['alpha']),{hits4:0,hits10:1,mrr10:.2,map10:.2});
 assert.deepEqual(scoreRetrieval([...Array(10).fill('irrelevant'),'alpha'],['alpha']),{hits4:0,hits10:0,mrr10:0,map10:0});
 assert.equal(scoreRetrieval(['ab'],['a b','ab']).map10,.5);
 const facts=Array.from({length:20},(_,i)=>`Fact ${i}.`);
 assert.equal(scoreRetrieval([facts.join(' ')],facts).map10,2);
 assert.throws(()=>scoreRetrieval([],[]),/gold facts/);
});

test('answer scoring reproduces loose word overlap without claiming semantic accuracy',()=>{
 assert.equal(scoreAnswer('Donald Duck','Donald Trump'),true);
 assert.equal(scoreAnswer('Yes.','Yes'),false);
 assert.equal(scoreAnswer('The answer to the question is "Yes". Explanation follows.','Yes'),true);
 assert.equal(scoreAnswer('ALPHA\tBETA','beta'),true);
 assert.equal(scoreAnswer('','alpha'),false);
});

const documents=[
 {id:'a',name:'A.txt',chunks:[{id:'a:0',index:0,page:null,text:'alpha fact',vector:[1,0]}]},
 {id:'b',name:'B.txt',chunks:[{id:'b:0',index:0,page:null,text:'other corpus text',vector:[0,1]}]},
];
const questions=[
 {index:0,query:'Known question?',answer:'alpha',questionType:'inference_query',facts:['alpha fact']},
 {index:1,query:'Unknown question?',answer:'Insufficient information.',questionType:'null_query',facts:[]},
];
const job={id:'job',manifest:{articles:2,questions:2},modes:['hybrid','jev','keyword'],settings:{topK:10,semanticThreshold:.5,threshold:.5},rates:defaultRates};
function fixture(){
 const records=new Map(),requests=[],retrievals=[];
 const candidate={...benchmarkChunks(documents)[0],label:'C1',retrievalRank:1,similarity:.8};
 const deps={
  retrieve:async question=>{retrievals.push(question);return {candidates:question===questions[0].query?[candidate]:[],ms:1,timings:{retrieval:1}};},
  load:async index=>records.has(index)?structuredClone(records.get(index)):undefined,
  save:async record=>{records.set(record.index,structuredClone(record));return summarizeQuestion(record,defaultRates);},
  summaries:async()=>[...records.values()].map(record=>summarizeQuestion(record,defaultRates)),
  generate:async(mode,question,candidates,emit)=>{
   requests.push({mode,question,candidates});
   const known=question===questions[0].query,found=known?[candidate]:[];
   if(mode==='keyword')emit({type:'retrieved',candidates:found,retrievalMs:1});
   if(known)emit({type:'model-call',call:{id:'call-1',stage:'answer',model:'openai/gpt-5-mini',status:'complete',request:{prompt:question},usage:{inputTokens:20,outputTokens:5}}});
   emit({type:'selected',ranked:found.map(c=>({id:c.id,label:c.label,rank:1,kept:true,score:null,reason:'Kept'})),context:{system:'Evidence only',prompt:'Corpus text'}});
   emit({type:'answer',answer:known?'alpha [C1]':'No matching passages.',skipped:!known});
   return {skipped:!known};
  },
 };
 return {records,requests,retrievals,deps,candidate};
}

test('all questions and modes run with shared hybrid retrieval and references isolated',async()=>{
 const f=fixture();
 assert.equal(await executeBenchmark(job,questions,documents,f.deps,new AbortController().signal),'completed');
 assert.equal(f.requests.length,6);
 assert.deepEqual(f.retrievals,questions.map(q=>q.query));
 assert.deepEqual(f.requests[0].candidates,f.requests[1].candidates);
 assert.equal(f.requests[2].candidates.length,documents.length);
 assert(f.requests.every(r=>typeof r.question==='string'&&!('answer' in r)&&!('facts' in r)));
 const stats=summarizeBenchmark(job,await f.deps.summaries());
 assert(stats.every(row=>row.full&&row.completed===2&&row.answerOverlap===1&&row.retrievalCount===1));
 assert(stats.every(row=>row.byType.null_query.completed===1));
 const record=f.records.get(1);
 assert(record.attempts.every(a=>a.abstained&&a.prediction==='Insufficient information.'));
 assert(f.records.get(0).attempts.every(a=>a.run.calls[0].usage.inputTokens===20));
});

test('generation requests whitelist fields and never carry answer keys or vectors',()=>{
 const request=generationRequest('jev','Query',{...job.settings,answer:'FORBIDDEN'},[{...fixture().candidate,vector:[9],gold_answer:'FORBIDDEN',facts:['FORBIDDEN']}]);
 assert.deepEqual(Object.keys(request).sort(),['candidates','mode','question','settings']);
 assert(!JSON.stringify(request).includes('FORBIDDEN'));
 assert(!('vector' in request.candidates[0]));
 assert.equal(request.settings.retryOnEmpty,false);
 assert(!('vector' in benchmarkChunks(documents)[0]));
});

test('resume skips saved modes and reuses the original candidate set',async()=>{
 const f=fixture(),first=new AbortController();
 f.deps.saved=summary=>{if(summary.index===0&&summary.modes.hybrid?.phase==='done')first.abort();};
 assert.equal(await executeBenchmark(job,questions,documents,f.deps,first.signal),'paused');
 assert.equal(f.requests.length,1);
 delete f.deps.saved;
 assert.equal(await executeBenchmark(job,questions,documents,f.deps,new AbortController().signal),'completed');
 assert.equal(f.requests.length,6);
 assert.equal(f.retrievals.length,2);
 assert.deepEqual(f.requests[0].candidates,f.requests[1].candidates);
 const before=f.requests.length;
 assert.equal(await executeBenchmark(job,questions,documents,f.deps,new AbortController().signal),'completed');
 assert.equal(f.requests.length,before);
});

test('pausing after a terminal answer preserves that completed mode',async()=>{
 const f=fixture(),controller=new AbortController(),generate=f.deps.generate;
 f.deps.generate=async(...args)=>{await generate(...args);controller.abort();throw new Error('Request aborted after the answer arrived');};
 assert.equal(await executeBenchmark(job,questions,documents,f.deps,controller.signal),'paused');
 assert.equal(f.records.get(0).attempts[0].run.phase,'done');
 f.deps.generate=generate;
 await executeBenchmark(job,questions,documents,f.deps,new AbortController().signal);
 assert.equal(f.requests.length,6);
});

test('context failures are recorded without scoring and do not prevent remaining cases',async()=>{
 const f=fixture(),generate=f.deps.generate;
 f.deps.generate=async(mode,...args)=>{
  if(mode==='keyword')throw Object.assign(new Error('Context window exceeded'),{code:'context_window'});
  return generate(mode,...args);
 };
 assert.equal(await executeBenchmark(job,questions,documents,f.deps,new AbortController().signal),'completed_with_errors');
 assert(f.records.get(0).attempts.find(a=>a.run.mode==='keyword').score===null);
 const grep=summarizeBenchmark(job,await f.deps.summaries()).find(row=>row.mode==='keyword');
 assert.equal(grep.full,false);assert.equal(grep.failed,2);assert.equal(grep.completed,0);assert.equal(grep.answerOverlap,null);
 assert.equal(await executeBenchmark(job,questions,documents,f.deps,new AbortController().signal),'completed_with_errors');
});

test('provider failure stops the batch and resume preserves its attempt history',async()=>{
 const f=fixture(),generate=f.deps.generate;
 let fail=true;
 f.deps.generate=async(...args)=>{
  if(fail){fail=false;throw Object.assign(new Error('Credential rejected'),{code:'credentials'});}
  return generate(...args);
 };
 await assert.rejects(executeBenchmark(job,questions,documents,f.deps,new AbortController().signal),/Credential/);
 assert.equal(f.records.size,1);
 assert.equal(f.records.get(0).attempts[0].score,null);
 await executeBenchmark(job,questions,documents,f.deps,new AbortController().signal);
 assert.equal(f.records.get(0).attempts.filter(a=>a.run.mode==='hybrid').length,2);
 const summary=summarizeQuestion(f.records.get(0));
 assert(summary.modes.hybrid.unreported>0);
});

test('saving failure stops before a provider request and incomplete runs cannot score',async()=>{
 const f=fixture();let saves=0;
 f.deps.save=async record=>{if(++saves===2)throw new Error('Storage full');f.records.set(record.index,structuredClone(record));return summarizeQuestion(record);};
 await assert.rejects(executeBenchmark(job,questions,documents,f.deps,new AbortController().signal),/Storage full/);
 assert.equal(f.requests.length,0);
 assert.throws(()=>scoreRun(questions[1],{phase:'error'},true),/Incomplete/);
 await assert.rejects(executeBenchmark(job,questions.slice(0,1),documents,fixture().deps,new AbortController().signal),/complete question set/);
 assert.throws(()=>summarizeBenchmark(job,[{jobId:'job',index:0,modes:{}},{jobId:'job',index:0,modes:{}}]),/Duplicate/);
});

test('benchmark parsing retains all official questions, including the no-answer cases',async()=>{
 const raw=JSON.parse(await readFile(new URL('../public/datasets/multihop-rag/MultiHopRAG.json',import.meta.url),'utf8'));
 const parsed=parseBenchmarkQuestions(raw);
 assert.equal(parsed.length,2556);
 assert.equal(parsed.filter(q=>q.questionType==='null_query').length,301);
 assert.equal(parsed.filter(q=>q.questionType!=='null_query').length,2255);
 assert(parsed.every((q,index)=>q.index===index&&q.query===raw[index].query));
 assert.throws(()=>parseBenchmarkQuestions([{query:'Invalid',answer:'X',question_type:'inference_query',evidence_list:[]}]),/reference evidence/);
});
