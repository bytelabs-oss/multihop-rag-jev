import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateCost,formatCost,defaultRates} from '../lib/cost.mjs';
const gpt=usage=>({model:'openai/gpt-5-mini',usage});
test('prices cached input separately and includes reasoning exactly once',()=>{
 const result=estimateCost([gpt({inputTokens:1000,outputTokens:500,inputTokenDetails:{cacheReadTokens:800},outputTokenDetails:{reasoningTokens:300}})]);
 assert(Math.abs(result.usd-.00107)<1e-12);assert.equal(result.missing,0);
});
test('JEV output is free and original comparison uses distinct model rates',()=>{
 const result=estimateCost([{model:'jev-latest',usage:{input_tokens:43224,output_tokens:654}},gpt({inputTokens:3460,outputTokens:537})]);
 assert(Math.abs(result.usd-.003754408)<1e-12);
 assert.equal(estimateCost([{model:'jev-latest',usage:{input_tokens:1000}}]).missing,0);
});
test('unknown rates or missing usage do not become zero cost',()=>{
 assert.equal(formatCost(estimateCost([gpt(null)])),'Unreported');
 assert.equal(estimateCost([{model:'unknown',usage:{inputTokens:1,outputTokens:1}}]).missing,1);
 assert.match(formatCost(estimateCost([gpt(null),gpt({inputTokens:100,outputTokens:100})])),/unreported/);
 assert.equal(estimateCost([gpt({inputTokens:1,outputTokens:2,inputTokenDetails:{cacheReadTokens:3}})]).missing,1);
 assert.equal(formatCost(estimateCost([])),'$0.000000');
});
test('editing rates reprices all calls including planning and retries without mutating defaults',()=>{
 const calls=[gpt({inputTokens:100,outputTokens:10}),gpt({inputTokens:100,outputTokens:10})];
 const rates={...defaultRates,'openai/gpt-5-mini':{input:1,cached:1,output:1}};
 assert.equal(estimateCost(calls,rates).usd,.00022);
 assert.equal(defaultRates['openai/gpt-5-mini'].input,.25);
});
