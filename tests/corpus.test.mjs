import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseCorpus,parseQuestions,selectItems,buildQuestionCatalogue,questionsForDocuments} from '../lib/corpus.mjs';
import {articleId} from '../lib/cache.mjs';

test('imports articles independently, preserves metadata and body, ignores unrelated fields',()=>{
 const articles=parseCorpus([{title:'First',body:'Full article text.',source:'News',published_at:'2023-11-27',author:null,url:'https://example.com/a',extra:'DO NOT IMPORT'},{title:'Second',body:'Second article.'}]);
 assert.equal(articles.length,2);
 assert.equal(articles[0].source,'News');assert.equal(articles[0].published_at,'2023-11-27');
 assert.equal(articles[0].body,'Full article text.');assert.equal(articles[0].extra,undefined);
 assert.equal(articles[1].body,'Second article.');
});
test('rejects question files and validates the entire corpus before import',()=>{
 for(const value of [[],{},[{query:'Question?',answer:'Secret',evidence_list:[]}],[{title:'Okay',body:'Text'},{title:'Missing body'}],[{title:'Title',body:'Text',source:{}}],[{title:'Title',body:'Text',answer:'Secret'}]])assert.throws(()=>parseCorpus(value));
});

test('article sampling is bounded and repeatable without changing corpus order',async()=>{
 const {selectArticles}=await import('../lib/corpus.mjs');const articles=Array.from({length:609},(_,id)=>({id}));
 assert.equal(selectArticles(articles,20,'first').length,20);
 assert.deepEqual(selectArticles(articles,20,'first').map(a=>a.id),Array.from({length:20},(_,i)=>i));
 const sample=selectArticles(articles,50,'random');assert.deepEqual(sample,selectArticles(articles,50,'random'));assert.equal(new Set(sample.map(a=>a.id)).size,50);assert.equal(articles[0].id,0);
});

test('question parsing exposes query and answer text, never evidence labels',()=>{
 const data=[{query:'  Which source reports the date?  ',answer:'  The Verge  ',evidence_list:[{fact:'EVIDENCE_KEY_ONLY'}],question_type:'inference_query'},{query:'What changed?',answer:'Nothing'}];
 assert.deepEqual(parseQuestions(data),[{query:'Which source reports the date?',answer:'The Verge'},{query:'What changed?',answer:'Nothing'}]);
 assert.equal(data[0].query,'  Which source reports the date?  ');
 assert(!JSON.stringify(parseQuestions(data)).includes('KEY_ONLY'));
});

test('question parsing rejects empty files, article files, and malformed query or answer fields',()=>{
 for(const value of [[],{},null,[null],[{title:'Article',body:'Text'}],[{query:''}],[{query:'  '}],[{query:42}],[{query:'Valid',answer:'Ok'},{answer:'Missing query'}],[{query:'Valid'}],[{query:'Valid',answer:''}],[{query:'Valid',answer:42}]])assert.throws(()=>parseQuestions(value));
});

test('question examples vary by seed without changing source text, identity, or order',()=>{
 const questions=Array.from({length:100},(_,index)=>({index,question:`Dataset question ${index}?`}));
 const original=structuredClone(questions);
 const first=selectItems(questions,10,'random');
 assert.equal(first.length,10);
 assert.equal(new Set(first.map(q=>q.index)).size,10);
 assert(first.every(q=>q===questions[q.index]));
 assert.deepEqual(first,selectItems(questions,10,'random',42));
 assert.notDeepEqual(first,selectItems(questions,10,'random',43));
 for(const count of [25,50])assert.equal(selectItems(questions,count,'random').length,count);
 assert.deepEqual(questions,original);
 const matches=questions.filter(q=>q.index<3);
 assert.equal(selectItems(matches,10,'random').length,3);
 assert(selectItems(matches,10,'random').every(q=>matches.includes(q)));
 assert.deepEqual(selectItems([],10,'random'),[]);
});

test('sampling rejects invalid counts, methods, and seeds',()=>{
 for(const count of [0,-1,1.5,NaN])assert.throws(()=>selectItems([],count,'random'));
 for(const seed of [-1,1.5,NaN,4294967296])assert.throws(()=>selectItems([],10,'random',seed));
 assert.throws(()=>selectItems(null,10,'random'));
 assert.throws(()=>selectItems([],10,'unsupported'));
});

test('bundled questions match their manifest and remain separate from the corpus',async()=>{
 const base=new URL('../public/datasets/multihop-rag/',import.meta.url);
 const manifest=JSON.parse(await readFile(new URL('manifest.json',base),'utf8'));
 const data=await readFile(new URL(manifest.questionFile,base));
 const raw=JSON.parse(data.toString('utf8'));
 const questions=parseQuestions(raw);
 assert.equal(createHash('sha256').update(data).digest('hex'),manifest.questionsSha256);
 assert.equal(questions.length,manifest.questions);
 assert(questions.every(q=>typeof q.query==='string'&&q.query.length>0&&typeof q.answer==='string'&&q.answer.length>0));
 assert.deepEqual(questions,raw.map(item=>({query:item.query.trim(),answer:item.answer.trim()})));
 const examples=selectItems(questions,10,'random');
 assert.equal(examples.length,10);
 assert(examples.every(question=>questions.includes(question)));
 assert.throws(()=>parseCorpus(raw));
 const corpus=await readFile(new URL('corpus.json',base));
 assert.equal(createHash('sha256').update(corpus).digest('hex'),manifest.sha256);
});

test('question coverage requires every source, excludes null queries, and uses existing cache IDs',async()=>{
 const corpus=[
  {title:' First article ',body:'First body.',url:'https://example.com/first',source:'One'},
  {title:'Second article',body:'Second body.',url:'https://example.com/second',source:'Two'},
 ];
 const question=(query,urls)=>({query,question_type:'inference_query',answer:'REFERENCE_ANSWER_ONLY',evidence_list:urls.map(url=>({url,fact:'REFERENCE_FACT_ONLY'}))});
 const data=[
  question('First question?',[corpus[0].url]),
  question('Needs both articles?',[corpus[0].url,corpus[1].url,corpus[0].url]),
  {...question('Intentional no-answer question?',[]),question_type:'null_query'},
  question('An unavailable source?',[corpus[0].url,'https://example.com/missing']),
 ];
 const before=structuredClone({corpus,data});
 const documents=await Promise.all(parseCorpus(corpus).map(async article=>({id:await articleId(article)})));
 const catalogue=await buildQuestionCatalogue(data,corpus);
 assert.deepEqual(catalogue.map(q=>q.index),[0,1]);
 assert.deepEqual(catalogue[1].articleIds,documents.map(d=>d.id));
 assert.deepEqual(questionsForDocuments(catalogue,[]),[]);
 assert.deepEqual(questionsForDocuments(catalogue,[documents[0]]).map(q=>q.index),[0]);
 assert.deepEqual(questionsForDocuments(catalogue,documents).map(q=>q.index),[0,1]);
 assert.deepEqual(questionsForDocuments(catalogue,[documents[1]]),[]);
 assert.deepEqual(questionsForDocuments(catalogue,JSON.parse(JSON.stringify(documents))).map(q=>q.index),[0,1]);
 assert.deepEqual(questionsForDocuments(catalogue,[{id:'upload-with-the-same-title',name:'First article'}]),[]);
 assert(!JSON.stringify(catalogue).includes('REFERENCE_FACT_ONLY'));
 assert(catalogue.every(q=>q.answer==='REFERENCE_ANSWER_ONLY'));
 assert(catalogue.every(q=>Object.keys(q).sort().join(',')==='answer,articleIds,index,question'));
 assert.deepEqual({corpus,data},before);
});

test('invalid source metadata reports errors instead of offering unsupported questions',async()=>{
 const corpus=[{title:'Article',body:'Text',url:'https://example.com/article'}];
 for(const item of [
  {query:'Question?',answer:'Answer',evidence_list:[{url:corpus[0].url}]},
  {query:'Question?',answer:'Answer',question_type:'inference_query',evidence_list:[]},
  {query:'Question?',answer:'Answer',question_type:'inference_query',evidence_list:[{fact:'Missing URL'}]},
  {query:'Question?',answer:'Answer',question_type:'inference_query',evidence_list:[{url:'https://example.com/unknown'},{url:42}]},
 ])await assert.rejects(buildQuestionCatalogue([item],corpus));
 const valid=[{query:'Question?',answer:'Answer',question_type:'inference_query',evidence_list:[{url:corpus[0].url}]}];
 await assert.rejects(buildQuestionCatalogue(valid,[{title:'No URL',body:'Text'}]),/source URL/);
 await assert.rejects(buildQuestionCatalogue(valid,[...corpus,...corpus]),/duplicate source URLs/);
});

test('real dataset availability follows the full loaded article set, not the number of examples',async()=>{
 const base=new URL('../public/datasets/multihop-rag/',import.meta.url);
 const [rawQuestions,rawCorpus]=await Promise.all([
  readFile(new URL('MultiHopRAG.json',base),'utf8').then(JSON.parse),
  readFile(new URL('corpus.json',base),'utf8').then(JSON.parse),
 ]);
 const articles=parseCorpus(rawCorpus);
 const [catalogue,documents]=await Promise.all([
  buildQuestionCatalogue(rawQuestions,rawCorpus),
  Promise.all(articles.map(async article=>({id:await articleId(article)}))),
 ]);
 assert.equal(catalogue.length,2255);
 for(const [count,expected] of [[10,11],[20,41],[50,302],[100,563],[609,2255]]){
  const available=questionsForDocuments(catalogue,documents.slice(0,count));
  const loadedUrls=new Set(articles.slice(0,count).map(article=>article.url));
  assert.equal(available.length,expected,`${count} articles`);
  assert(available.every(q=>rawQuestions[q.index].question_type!=='null_query'));
  assert(available.every(q=>rawQuestions[q.index].evidence_list.every(e=>loadedUrls.has(e.url))));
  assert(selectItems(available,10,'random').every(q=>available.includes(q)));
 }
 const firstHundred=questionsForDocuments(catalogue,documents.slice(0,100));
 assert(!catalogue.some(q=>q.index===158),'Ross Atkins is an intentional no-answer control');
 assert(!firstHundred.some(q=>q.index===1),'Manhattan valuation requires articles outside the first 100');
 assert(!firstHundred.some(q=>q.index===0),'The first FTX question needs an additional source');
 assert(questionsForDocuments(catalogue,[...documents.slice(0,100),documents[175]]).some(q=>q.index===0));
 assert(questionsForDocuments(catalogue,[documents[529],documents[530]]).some(q=>q.index===1));
});
