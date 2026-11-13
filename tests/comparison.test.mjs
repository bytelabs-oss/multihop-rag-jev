import test from 'node:test';
import assert from 'node:assert/strict';
import {comparisonRow} from '../lib/comparison.mjs';
import {defaultRates} from '../lib/cost.mjs';
const base={phase:'done',candidates:[{},{}],ranked:[{kept:true},{kept:false}],context:{},elapsedMs:2500};
test('comparison keeps model totals separate and measures retained passages',()=>{
 const row=comparisonRow({...base,calls:[{model:'jev-latest',stage:'relevance',usage:{input_tokens:1000,output_tokens:10}},{model:'openai/gpt-5-mini',stage:'answer',usage:{inputTokens:200,outputTokens:100}}]},defaultRates);
 assert.equal(row.retrieved,2);assert.equal(row.kept,1);assert.equal(row.seconds,2.5);
 assert.equal(row.jevTokens,1010);assert.equal(row.gptTokens,300);assert(Math.abs(row.cost-.000292)<1e-12);
 assert.equal(row.answerCalled,true);assert.equal(row.answerTokens,300);assert.equal(row.totalTokens,1310);
 assert(Math.abs(row.answerCost-.00025)<1e-12);
 // Blended $/Mtok actually paid: jevCost/jevTokens*1e6 and gptCost/gptTokens*1e6.
 // The free output tokens (10) dilute JEV's blended rate slightly below its $0.042 input rate.
 assert(Math.abs(row.jevRatePerMtok-.000042/1010*1e6)<1e-9);
 assert(Math.abs(row.gptRatePerMtok-(200*.25+100*2)/300)<1e-9);
});
test('an engine with no calls in the group has no rate, not a zero rate',()=>{
 const row=comparisonRow({...base,calls:[{model:'openai/gpt-5-mini',stage:'answer',usage:{inputTokens:200,outputTokens:100}}]},defaultRates);
 assert.equal(row.jevTokens,0);assert.equal(row.jevRatePerMtok,null);
 assert(row.gptRatePerMtok>0);
});
test('failed and missing usage cannot produce completed chart values',()=>{
 const row=comparisonRow({...base,phase:'error',calls:[{model:'openai/gpt-5-mini',stage:'answer',usage:null}]},defaultRates);
 assert.equal(row.complete,false);assert.equal(row.gptCost,null);assert.equal(row.gptTokens,null);assert.equal(row.cost,null);
 assert.equal(row.jevCost,0);
 assert.equal(row.answerCalled,true);assert.equal(row.answerTokens,null);assert.equal(row.answerCost,null);assert.equal(row.totalTokens,null);
});

test('shared answer comparison excludes keyword planning and query rewriting',()=>{
 const row=comparisonRow({...base,calls:[
  {model:'openai/gpt-5-mini',stage:'keywords',usage:{inputTokens:100,outputTokens:10}},
  {model:'openai/gpt-5-mini',stage:'rewrite',usage:{inputTokens:40,outputTokens:10}},
  {model:'openai/gpt-5-mini',stage:'answer',usage:{inputTokens:200,outputTokens:50}},
 ]},defaultRates);
 assert.equal(row.answerTokens,250);
 assert.equal(row.gptTokens,410);
 assert.equal(row.totalTokens,410);
 assert(Math.abs(row.answerCost-.00015)<1e-12);
 assert(Math.abs(row.cost-.000225)<1e-12);
});

test('a skipped answer is not presented as a free completed GPT answer',()=>{
 const row=comparisonRow({...base,calls:[
  {model:'jev-latest',stage:'relevance',usage:{input_tokens:1000,output_tokens:10}},
 ]},defaultRates);
 assert.equal(row.complete,true);
 assert.equal(row.answerCalled,false);
 assert.equal(row.answerTokens,null);
 assert.equal(row.answerCost,null);
 assert.equal(row.totalTokens,1010);
 assert(Math.abs(row.cost-.000042)<1e-12);
});

test('missing overhead usage does not hide known answer usage or invent a total',()=>{
 const row=comparisonRow({...base,calls:[
  {model:'openai/gpt-5-mini',stage:'keywords',usage:null},
  {model:'openai/gpt-5-mini',stage:'answer',usage:{inputTokens:200,outputTokens:50}},
 ]},defaultRates);
 assert.equal(row.answerTokens,250);
 assert(Math.abs(row.answerCost-.00015)<1e-12);
 assert.equal(row.totalTokens,null);
 assert.equal(row.cost,null);
});
