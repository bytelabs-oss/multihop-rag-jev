import {isCaseFailure,scoreRun} from './benchmark-metrics.mjs';

/** @param {import('./documents').Doc[]} documents @returns {import('./experiment').Candidate[]} */
export function benchmarkChunks(documents){
 return documents.flatMap(doc=>doc.chunks.map(chunk=>{
  const candidate={...chunk,docId:doc.id,docName:doc.name,label:'',retrievalRank:0,similarity:0,bm25Score:0,hybridScore:0,semanticRank:null,lexicalRank:null};
  delete candidate.vector;
  return candidate;
 }));
}

/** @param {import('./documents').Doc[]} documents @returns {{id:string,name:string,body:string}[]} */
export function benchmarkDocuments(documents){
 return documents.map(doc=>({id:doc.id,name:doc.name,body:doc.body??doc.chunks.map(c=>c.body??c.text).join('\n\n')}));
}

/** @param {import('./experiment').ComparisonMode} mode @param {string} question @param {import('./experiment').Settings} settings @param {import('./experiment').Candidate[]|{id:string,name:string,body:string}[]} payload */
export function generationRequest(mode,question,settings,payload){
 const request={mode,question,settings:{topK:settings.topK,semanticThreshold:settings.semanticThreshold,threshold:settings.threshold,retryOnEmpty:false}};
 if(mode==='keyword'||mode==='keyword-jev')request.documents=payload.map(({id,name,body})=>({id,name,body}));
 else request.candidates=payload.map(({id,docName,index,page,text,similarity})=>({id,docName,index,page,text,similarity}));
 return request;
}

/** @param {import('./experiment').Run} run @param {import('./benchmark-types').PipelineEvent} event @param {Map<string,import('./experiment').Candidate>} corpus @param {Map<string,{id:string,name:string,body:string}>} docsById @returns {import('./experiment').Run} */
function applyEvent(run,event,corpus,docsById){
 switch(event.type){
  case 'model-call':{
   const call={...event.call,id:`${run.id}-${event.call.id}`};
   const calls=[...(run.calls??[])],index=calls.findIndex(c=>c.id===call.id);
   if(index<0)calls.push(call);else calls[index]=call;
   return {...run,calls};
  }
  case 'searching':return {...run,phase:'searching',progress:event.progress};
  case 'retrieved':return {...run,phase:'retrieved',searchTerms:event.searchTerms,retrievalMs:event.retrievalMs,retrievalTimings:event.retrievalTimings,candidates:event.candidates.map(candidate=>{
   const original=corpus.get(candidate.id);
   if(!original)throw new Error('Retrieved evidence is outside the benchmark corpus.');
   return {...original,...candidate,bm25Score:0,hybridScore:0,semanticRank:null,lexicalRank:null,retrievalReason:'keyword'};
  })};
  case 'keyword-attempt':return {...run,phase:'searching',progress:`Searched /${event.pattern}/i · ${event.matches} match${event.matches===1?'':'es'}`};
  case 'keyword-blocks':return {...run,phase:'searching',candidates:event.blocks.map(block=>{
   const doc=docsById.get(block.docId);
   if(!doc||doc.body.slice(block.start,block.end)!==block.text)throw new Error('Retrieved keyword evidence is outside the benchmark corpus.');
   return {id:block.id,docId:block.docId,docName:block.docName,label:block.label,index:0,start:block.start,end:block.end,page:null,text:block.text,similarity:0,bm25Score:0,hybridScore:0,semanticRank:null,lexicalRank:null,retrievalRank:block.rank,retrievalReason:'keyword'};
  })};
  case 'ranking':return {...run,phase:'ranking',questions:event.questions};
  case 'relevance-progress':return {...run,progress:`Relevance ${event.completed} / ${event.total}`};
  case 'ranked':return {...run,phase:'selecting',ranked:event.ranked,jevAnswers:event.jevAnswers,jevUsage:event.jevUsage,jevMs:event.jevMs};
  case 'selecting':return {...run,phase:'selecting',progress:event.progress};
  case 'selection-step':return {...run,ranked:run.ranked.map(r=>r.id===event.decision.id?event.decision:r),selection:event.check?[...(run.selection??[]),event.check]:run.selection};
  case 'selected':return {...run,ranked:event.ranked,context:event.context,selection:event.selection,jevMs:event.jevMs};
  case 'answering':return {...run,phase:'answering',progress:undefined};
  case 'answer-delta':return {...run,phase:'answering',answer:(run.answer??'')+event.delta};
  case 'answer':return {...run,phase:'done',answer:event.answer,llmUsage:event.llmUsage,llmMs:event.llmMs,progress:undefined};
  case 'error':return {...run,phase:'error',error:event.error};
  default:return run;
 }
}

/**
 * @param {import('./benchmark-types').BenchmarkJob} job
 * @param {import('./benchmark-types').BenchmarkQuestion[]} questions
 * @param {import('./documents').Doc[]} documents
 * @param {import('./benchmark-types').BenchmarkDependencies} dependencies
 * @param {AbortSignal} signal
 * @returns {Promise<'completed'|'completed_with_errors'|'paused'>}
 */
export async function executeBenchmark(job,questions,documents,dependencies,signal){
 if(questions.length!==job.manifest.questions||documents.length!==job.manifest.articles)throw new Error('A full benchmark requires the complete question set and corpus.');
 if(questions.some((q,index)=>q.index!==index))throw new Error('Benchmark question order is invalid.');
 if(questions.some(q=>!q.query.trim()||!q.answer.trim()||(q.questionType!=='null_query'&&!q.facts.length)))throw new Error('Benchmark references are incomplete.');
 if(!job.modes.length||new Set(job.modes).size!==job.modes.length||job.modes.some(m=>!['hybrid','jev','keyword','keyword-jev'].includes(m)))throw new Error('Choose valid benchmark modes.');
 const chunks=benchmarkChunks(documents),corpus=new Map(chunks.map(c=>[c.id,c]));
 if(corpus.size!==chunks.length)throw new Error('The benchmark corpus has duplicate chunk IDs.');
 const rawDocuments=benchmarkDocuments(documents),docsById=new Map(rawDocuments.map(d=>[d.id,d]));
 const saved=await dependencies.summaries();
 if(new Set(saved.map(s=>s.index)).size!==saved.length||saved.some(s=>s.jobId!==job.id||!Number.isInteger(s.index)||s.index<0||s.index>=questions.length))throw new Error('Saved benchmark summaries are inconsistent.');
 const summaries=new Map(saved.map(summary=>[summary.index,summary]));
 let failures=false;
 async function checkpoint(record){
  const summary=await dependencies.save(record);
  summaries.set(record.index,summary);
  dependencies.saved?.(summary,record);
 }
 for(const question of questions){
  if(signal.aborted)return 'paused';
  const prior=summaries.get(question.index);
  if(job.modes.every(mode=>prior?.modes[mode]?.settled)){
   if(job.modes.some(mode=>prior.modes[mode].phase!=='done'))failures=true;
   continue;
  }
  const record=await dependencies.load(question.index)??{jobId:job.id,index:question.index,question,attempts:[]};
  if(record.jobId!==job.id||record.index!==question.index||JSON.stringify(record.question)!==JSON.stringify(question))throw new Error('Saved results do not match this dataset.');
  if(record.retrieval?.candidates.some(c=>corpus.get(c.id)?.text!==c.text||corpus.get(c.id)?.docName!==c.docName))throw new Error('Saved retrieval no longer matches the benchmark corpus.');
  for(const mode of job.modes){
   if(signal.aborted)return 'paused';
   const attempts=record.attempts.filter(a=>a.run.mode===mode),previous=attempts.at(-1);
   if(previous?.run.phase==='done')continue;
   if(previous?.run.phase==='error'&&isCaseFailure(previous.errorCode)){failures=true;continue;}
   if(previous&&!['done','error','cancelled'].includes(previous.run.phase)){
    previous.run={...previous.run,phase:'cancelled',usageIncomplete:true,error:'Interrupted before the final response was saved. Usage may be incomplete.'};
    previous.usageIncomplete=true;
    await checkpoint(record);
   }
   if(mode!=='keyword'&&mode!=='keyword-jev'&&!record.retrieval){
    dependencies.progress?.({questionIndex:question.index,mode,stage:'Retrieving shared hybrid candidates'});
    try{
     record.retrieval=await dependencies.retrieve(question.query,signal);
     if(record.retrieval.candidates.some(c=>corpus.get(c.id)?.text!==c.text||corpus.get(c.id)?.docName!==c.docName))throw new Error('Retrieval returned evidence outside the benchmark corpus.');
     await checkpoint(record);
    }catch(error){if(signal.aborted)return 'paused';throw error;}
   }
   /** @type {import('./benchmark-types').BenchmarkAttempt} */
   const attempt={
    run:{id:crypto.randomUUID(),groupId:`${job.id}:${question.index}`,attempt:attempts.length+1,usageIncomplete:true,question:question.query,mode,settings:{...job.settings,retryOnEmpty:false},
     phase:(mode==='keyword'||mode==='keyword-jev')?'searching':'retrieved',candidates:(mode==='keyword'||mode==='keyword-jev')?[]:record.retrieval.candidates,ranked:[],calls:[],
     retrievalMs:(mode==='keyword'||mode==='keyword-jev')?undefined:record.retrieval.ms,retrievalTimings:(mode==='keyword'||mode==='keyword-jev')?undefined:record.retrieval.timings},
    score:null,usageIncomplete:true,
   };
   record.attempts.push(attempt);
   await checkpoint(record);
   const started=performance.now();
   let failure;
   let completedAnswer;
   function complete(skipped){
    attempt.run.usageIncomplete=false;
    attempt.usageIncomplete=false;
    attempt.abstained=!!skipped;
    attempt.prediction=skipped?'Insufficient information.':attempt.run.answer;
    attempt.score=scoreRun(question,attempt.run,!!skipped);
   }
   try{
    const terminal=await dependencies.generate(mode,question.query,(mode==='keyword'||mode==='keyword-jev')?rawDocuments:record.retrieval.candidates,event=>{
     attempt.run=applyEvent(attempt.run,event,corpus,docsById);
     if(event.type==='answer')completedAnswer=event;
     dependencies.progress?.({questionIndex:question.index,mode,stage:attempt.run.progress??attempt.run.phase});
    },signal);
    if(attempt.run.phase!=='done')throw new Error('The pipeline did not return a complete answer event.');
    complete(terminal.skipped);
   }catch(error){
    if(signal.aborted&&completedAnswer&&attempt.run.phase==='done')complete(completedAnswer.skipped);
    else{
     failure=error;
     attempt.errorCode=typeof error?.code==='string'?error.code:'pipeline';
     attempt.run={...attempt.run,phase:signal.aborted?'cancelled':'error',usageIncomplete:true,error:signal.aborted?'Benchmark paused. The interrupted request may have incurred charges.':error instanceof Error?error.message:'The benchmark request failed.',
      calls:attempt.run.calls?.map(call=>call.status==='running'?{...call,status:signal.aborted?'cancelled':'failed'}:call)};
     attempt.usageIncomplete=true;
    }
   }
   attempt.run.elapsedMs=performance.now()-started+((mode==='keyword'||mode==='keyword-jev')?0:record.retrieval.ms);
   await checkpoint(record);
   if(signal.aborted)return 'paused';
   if(attempt.run.phase==='error'){
    failures=true;
    if(!isCaseFailure(attempt.errorCode))throw failure instanceof Error?failure:new Error(attempt.run.error);
   }
  }
 }
 return failures?'completed_with_errors':'completed';
}
