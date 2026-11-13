import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCache,cachePayload,articleId} from '../lib/cache.mjs';
const doc=()=>({id:'a',name:'Article',chunks:[{id:'a:0',index:0,text:'Evidence',model:'BAAI/bge-small-en-v1.5',vector:Array(384).fill(.1)}]});
test('portable cache roundtrip retains embeddings and rejects incompatible or nonfinite vectors',()=>{
 const original=doc();assert.deepEqual(validateCache(JSON.parse(JSON.stringify(cachePayload([original])))),[original]);
 for(const mutate of [d=>d.chunks[0].vector.pop(),d=>d.chunks[0].vector[0]=Infinity,d=>d.chunks[0].model='wrong',d=>d.chunks[0].id='foreign:0']){const d=doc();mutate(d);assert.throws(()=>validateCache(cachePayload([d])));}
 assert.throws(()=>validateCache(cachePayload([doc(),doc()])));
});
test('article cache identity follows content and source metadata',async()=>{
 const a={title:'Test',body:'Evidence',source:'News',published_at:'2026-01-01'};
 assert.equal(await articleId(a),await articleId({...a}));
 assert.notEqual(await articleId(a),await articleId({...a,body:'Changed evidence'}));
 assert.notEqual(await articleId(a),await articleId({...a,source:'Other'}));
});
