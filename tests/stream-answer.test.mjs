import test from 'node:test';
import assert from 'node:assert/strict';
import {streamAnswer} from '../server/stream-answer.mjs';
const provider=parts=>()=>({fullStream:(async function*(){yield* parts;})(),totalUsage:Promise.resolve({inputTokens:10,outputTokens:5})});
test('streams text before completion and preserves provider usage',async()=>{
 const seen=[];
 const result=await streamAnswer(provider([{type:'text-delta',text:'A '},{type:'text-delta',text:'fact [C1].'},{type:'finish',finishReason:'stop'}]),{},text=>seen.push(text));
 assert.deepEqual(seen,['A ','fact [C1].']);assert.equal(result.text,seen.join(''));
 assert.equal(result.usage.outputTokens,5);assert.equal(result.finishReason,'stop');assert(result.firstTextMs>=0);
});
test('partial provider errors, aborted and incomplete streams do not succeed',async()=>{
 for(const tail of [[{type:'error',error:new Error('Provider failed')}],[{type:'abort'}],[]]){
  const seen=[];await assert.rejects(streamAnswer(provider([{type:'text-delta',text:'Partial'},...tail]),{},text=>seen.push(text)));
  assert.deepEqual(seen,['Partial']);
 }
});
