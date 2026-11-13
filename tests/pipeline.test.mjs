import test from 'node:test';
import assert from 'node:assert/strict';
import {runPipeline,validateInput,probability} from '../server/pipeline.mjs';
const settings={topK:20,semanticThreshold:.5,threshold:.5};
const chunk=(id,text)=>({id,docName:`${id}.txt`,index:0,page:null,text,similarity:.8});
const input=candidates=>({question:'How long are records retained and who approves exports?',settings,candidates});
const doc=(id,body)=>({id,name:`${id}.txt`,body});
const keywordInput=(documents,mode='keyword')=>({question:'How long are records retained and who approves exports?',settings,documents,mode});
const collect=()=>{const events=[];return {events,emit:e=>events.push(e)};};
test('rejects irrelevant, duplicate, and redundant evidence; forwards only kept passages',async()=>{
 const c=collect();const requests=[];let calls=0;let answerInput;
 const body=input([chunk('a','Records are retained for thirty days.'),{...chunk('b','Records are retained for thirty days.'),docName:'a.txt'},chunk('c','The cafeteria serves noodles.'),chunk('d','Retention lasts a period of thirty days.'),chunk('e','Security approves all exports.')]);
 await runPipeline(body,{evaluate:async req=>{requests.push(req);calls++;return calls===1?{answers:{C1:{probability:.99},C2:{probability:.98},C3:{probability:.02},C4:{probability:.97},C5:{probability:.96}}}:{answers:{adds_evidence:{probability:calls===2?.1:.95}}};},generateText:async req=>{answerInput=req;return {text:'Thirty days [C1]; security approves exports [C5].'};}},c.emit);
 const selection=c.events.find(e=>e.type==='selected');
 assert.deepEqual(selection.ranked.filter(c=>c.kept).map(c=>c.id),['a','e']);
 assert.equal(selection.ranked.find(c=>c.id==='b').reason,'Exact duplicate');
 assert.equal(selection.ranked.find(c=>c.id==='c').reason,'Below relevance threshold');
 assert.equal(selection.ranked.find(c=>c.id==='d').reason,'No added evidence');
 assert(!answerInput.prompt.includes('cafeteria'));assert(!answerInput.prompt.includes('period of'));
 assert.equal(requests[1].state.selected_evidence.length,1);
 assert.equal(requests[2].state.selected_evidence.length,1);
 assert.equal(answerInput.prompt,selection.context.prompt);
});
test('no valid evidence means no answer-model call',async()=>{
 const c=collect();let llmCalls=0;
 await runPipeline(input([chunk('a','Unrelated text'),chunk('b','Missing judgment')]),{evaluate:async()=>({answers:{C1:{probability:.1}}}),generateText:async()=>{llmCalls++;return {text:'wrong'};}},c.emit);
 assert.equal(llmCalls,0);assert.equal(c.events.at(-1).skipped,true);assert.equal(c.events.find(e=>e.type==='selected').ranked[1].score,null);
});
test('relevance batches visit every candidate beyond old caps',async()=>{
 const c=collect();let seen=0;
 await runPipeline(input(Array.from({length:73},(_,i)=>chunk(`item${i}`,`Evidence ${i}`))),{evaluate:async req=>{seen+=Object.keys(req.questions).length;return {answers:Object.fromEntries(Object.keys(req.questions).map(key=>[key,{probability:.1}]))};},generateText:async()=>{throw new Error('No answer expected');}},c.emit);
 assert.equal(seen,73);assert.equal(c.events.find(e=>e.type==='selected').ranked.length,73);
 assert.equal(c.events.filter(e=>e.type==='relevance-progress').at(-1).completed,73);
});
test('all useful evidence reaches answer without count or estimated-token caps',async()=>{
 const c=collect();let answer;
 const candidates=Array.from({length:12},(_,i)=>chunk(`item${i}`,`Unique evidence ${i}. `+'detail '.repeat(300)));
 await runPipeline(input(candidates),{evaluate:async req=>({answers:Object.fromEntries(Object.keys(req.questions).map(key=>[key,{probability:.9}]))}),generateText:async req=>{answer=req;return {text:'Answer [C12]'};}},c.emit);
 assert.equal(c.events.find(e=>e.type==='selected').ranked.filter(c=>c.kept).length,12);
 for(const candidate of candidates)assert(answer.prompt.includes(candidate.text));
});
test('abort after JEV prevents answering',async()=>{
 const ctrl=new AbortController();let answered=false;
 await assert.rejects(runPipeline(input([chunk('a','Evidence')]),{evaluate:async()=>{ctrl.abort();return {answers:{C1:{probability:.9}}};},generateText:async()=>{answered=true;return {text:'bad'};}},()=>{},ctrl.signal),/cancelled/);
 assert.equal(answered,false);
});
test('invalid score and invalid candidate IDs fail closed',()=>{
 for(const value of [undefined,{}, {probability:NaN},{probability:1.1},{probability:-.1},{probability:'0.9'}])assert.equal(probability(value),null);
 assert.equal(probability({noul:.3}),.3);
 assert.throws(()=>validateInput(input([chunk('same','a'),chunk('same','b')])));
});
test('model traces preserve exact inputs and usage for both JEV stages and GPT',async()=>{
 const c=collect();const requests=[];
 await runPipeline(input([chunk('a','First useful fact'),chunk('b','Second useful fact')]),{evaluate:async req=>{requests.push(req);return {answers:Object.fromEntries(Object.keys(req.questions).map(k=>[k,{probability:.9}])),usage:{input_tokens:40,output_tokens:2}};},generateText:async req=>{requests.push(req);return {text:'Answer',usage:{inputTokens:60,outputTokens:10}};}},c.emit);
 const calls=c.events.filter(e=>e.type==='model-call'&&e.call.status==='complete').map(e=>e.call);
 assert.deepEqual(calls.map(c=>c.stage),['relevance','contribution','answer']);
 for(let i=0;i<calls.length;i++){const {abortSignal,maxRetries,...expected}=requests[i];assert.deepEqual(calls[i].request,expected);}
 assert.equal(calls[0].usage.input_tokens,40);assert.equal(calls[1].usage.output_tokens,2);assert.equal(calls[2].usage.outputTokens,10);
});

test('hybrid baseline forwards every candidate without JEV and uses identical answer instructions',async()=>{
 const body=input(Array.from({length:80},(_,i)=>chunk(`item${i}`,`Evidence ${i}`)));
 const c=collect();let request;
 await runPipeline({...body,mode:'hybrid'},{evaluate:()=>{throw new Error('JEV must not run');},generateText:async args=>{request=args;return {text:'Answer',usage:{inputTokens:5,outputTokens:2}};}},c.emit);
 for(const candidate of body.candidates)assert(request.prompt.includes(candidate.text));
 assert.equal(c.events.find(e=>e.type==='selected').ranked.length,80);
 assert.deepEqual(c.events.filter(e=>e.type==='model-call'&&e.call.status==='complete').map(e=>e.call.stage),['answer']);
});
test('keyword mode lets the model call the search tool and sends its raw, unfiltered matches',async()=>{
 const c=collect();const requests=[];
 const documents=[doc('a','Unrelated introduction text.\nRecords are retained for thirty days.\nSecurity approves all exports.'),doc('b','Nothing relevant lives in this second document.')];
 await runPipeline(keywordInput(documents),{
  evaluate:()=>{throw new Error('JEV must not run in plain keyword mode');},
  generateAnswer:async(args,onText)=>{
   requests.push(args);
   const search=await args.tools.search.execute({pattern:'retained|approves'});
   assert.equal(search.matches.length,1);
   assert(search.matches[0].text.includes('Security approves'));
   const text=`Thirty days; security approves exports [${search.matches[0].label}].`;
   onText(text,5);
   return {text,usage:{inputTokens:40,outputTokens:9}};
  },
 },c.emit);
 assert.deepEqual(requests[0].tools.search.inputSchema===undefined,false);
 const attempt=c.events.find(e=>e.type==='keyword-attempt');
 assert.equal(attempt.pattern,'retained|approves');assert.equal(attempt.matches,1);
 const blocks=c.events.find(e=>e.type==='keyword-blocks');
 assert.deepEqual(blocks.blocks.map(b=>b.kept),[true]);
 const selected=c.events.find(e=>e.type==='selected');
 assert.deepEqual(selected.searchTerms,['retained|approves']);
 assert(c.events.at(-1).answer.includes('C1'));
 assert.deepEqual(c.events.filter(e=>e.type==='model-call'&&e.call.status==='complete').map(e=>e.call.stage),['answer']);
 assert.deepEqual(c.events.filter(e=>e.type==='model-call').map(e=>e.call.request.tools),[['search'],['search']]);
});
test('keyword+JEV mode filters newly found passages and never re-scores or re-shows already-judged ones',async()=>{
 const c=collect();const evaluated=[];
 const documents=[doc('a','Security approves all exports after strict review procedures.'),doc('b','The cafeteria serves noodles on Tuesdays and Fridays for lunch.')];
 await runPipeline(keywordInput(documents,'keyword-jev'),{
  evaluate:async req=>{
   evaluated.push(req);
   return {answers:Object.fromEntries(Object.entries(req.state.chunks).map(([label,c])=>[label,{probability:c.text.includes('Security approves')?0.95:0.05}]))};
  },
  generateAnswer:async(args,onText)=>{
   const first=await args.tools.search.execute({pattern:'approves|cafeteria'});
   assert.equal(first.matches.length,2);
   assert(first.matches[0].text.includes('Security approves'));
   assert.equal(first.matches[1].note,'Checked for relevance and dropped; not shown.');
   const second=await args.tools.search.execute({pattern:'approves|cafeteria'});
   assert.deepEqual(second.matches.map(m=>m.note),['Already shown above.','Already checked and dropped; not shown.']);
   const text='Security approves all exports [C1].';
   onText(text,4);
   return {text,usage:{inputTokens:20,outputTokens:8}};
  },
 },c.emit);
 assert.equal(evaluated.length,1);
 const selected=c.events.find(e=>e.type==='selected');
 assert.deepEqual(selected.ranked.filter(r=>r.kept).map(r=>r.label),['C1']);
 assert.equal(selected.ranked.find(r=>r.label==='C2').reason,'Below relevance threshold');
 assert.equal(c.events.at(-1).answer,'Security approves all exports [C1].');
});
test('keyword search tool reports invalid regex patterns without throwing, and no matches still lets the model answer',async()=>{
 const c=collect();
 const documents=[doc('a','Some evidence text unrelated to the pattern below.')];
 await runPipeline(keywordInput(documents),{
  generateAnswer:async(args,onText)=>{
   const bad=await args.tools.search.execute({pattern:'('});
   assert.equal(typeof bad.error,'string');
   const empty=await args.tools.search.execute({pattern:'nomatchxyz'});
   assert.equal(empty.matches.length,0);assert.equal(empty.note,'No matches for this pattern.');
   const text='Insufficient information.';
   onText(text,2);
   return {text,usage:{inputTokens:5,outputTokens:3}};
  },
 },c.emit);
 assert.equal(c.events.at(-1).answer,'Insufficient information.');
});
test('keyword modes require a document array and reject blank bodies',()=>{
 assert.throws(()=>validateInput({question:'q',settings,mode:'keyword'}));
 assert.throws(()=>validateInput({question:'q',settings,mode:'keyword',documents:[{id:'a',name:'a.txt',body:'   '}]}));
 assert.throws(()=>validateInput({question:'q',settings,mode:'keyword',documents:[{id:'a',name:'a.txt',body:'x'},{id:'a',name:'b.txt',body:'y'}]}));
});
test('empty hybrid result does not call models and invalid modes are rejected',async()=>{
 const c=collect();await runPipeline({...input([]),mode:'hybrid'},{generateText:()=>{throw new Error('Must skip');}},c.emit);
 assert.equal(c.events.at(-1).skipped,true);
 assert.throws(()=>validateInput({...input([]),mode:'other'}));
});

test('query rewrite uses only original question and traces GPT usage without JEV or an answer call',async()=>{
 const c=collect();let request;
 await runPipeline({...input([]),mode:'rewrite'},{evaluate:()=>{throw new Error('JEV should not run');},generateText:async args=>{request=args;return {text:'record retention export authorization',usage:{inputTokens:30,outputTokens:6}};}},c.emit);
 assert.equal(request.prompt,input([]).question);assert(request.system.includes('Do not answer'));
 assert.equal(c.events.at(-1).type,'rewritten');
 assert.equal(c.events.filter(e=>e.type==='model-call'&&e.call.status==='complete')[0].call.stage,'rewrite');
 assert.equal(c.events.filter(e=>e.type==='answer').length,0);
});

test('all answer modes share low reasoning settings and emit streamed partial answers',async()=>{
 const requests=[];
 for(const mode of ['hybrid','jev','keyword','keyword-jev']){
  const c=collect();
  const body=mode==='keyword'||mode==='keyword-jev'?keywordInput([doc('a','Records are retained for thirty days.')],mode):{...input([chunk('a','Records are retained for thirty days.')]),mode};
  await runPipeline(body,{
   evaluate:async req=>({answers:Object.fromEntries(Object.keys(req.questions).map(k=>[k,{probability:.9}]))}),
   generateAnswer:async(args,onText)=>{requests.push(args);onText('Thirty ',12);onText('days [C1].',12);return {text:'Thirty days [C1].',firstTextMs:12,finishReason:'stop',usage:{inputTokens:10,outputTokens:5}};}
  },c.emit);
  assert.equal(c.events.filter(e=>e.type==='answer-delta').length,2);
  assert.equal(c.events.at(-1).answer,'Thirty days [C1].');
  assert.equal(c.events.find(e=>e.type==='model-call'&&e.call.stage==='answer'&&e.call.status==='complete').call.firstTextMs,12);
 }
 assert(requests.every(r=>r.reasoning==='low'&&r.maxRetries===0));
 assert.equal(requests[0].system,requests[1].system);
 assert(requests[2].system.includes('search tool'));
 assert.notEqual(requests[2].system,requests[3].system);
});
test('output-limit termination cannot be reported as a complete answer',async()=>{
 const c=collect();await assert.rejects(runPipeline({...input([chunk('a','Evidence')]),mode:'hybrid'},{generateAnswer:async(args,onText)=>{onText('Partial',1);return {text:'Partial',finishReason:'length'};}},c.emit),/cut short/);
 assert(!c.events.some(e=>e.type==='answer'));
 assert.equal(c.events.at(-1).call.status,'failed');
});

test('uncertain contribution preserves evidence and cross-source duplicates reach JEV',async()=>{
 for(const score of [null,.19,.2,.49]){
  const c=collect();let checks=0;
  await runPipeline(input([chunk('a','An attributed claim'),chunk('b','An attributed claim')]),{
   evaluate:async req=>{if(req.state.candidate){checks++;return {answers:{adds_evidence:{probability:score}}};}return {answers:{C1:{probability:.9},C2:{probability:.8}}};},
   generateText:async()=>({text:'Answer'})
  },c.emit);
  assert.equal(checks,1);
  assert.equal(c.events.find(e=>e.type==='selected').ranked.filter(x=>x.kept).length,score===.19?1:2);
 }
});
