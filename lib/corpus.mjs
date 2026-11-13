import {articleId} from './cache.mjs';

// Explicit fields keep benchmark answers and evidence labels out of documents.
export function parseCorpus(value){
 if(!Array.isArray(value)||!value.length)throw new Error('Choose a corpus.json containing a nonempty array of articles.');
 return value.map((article,index)=>{
  if(!article||typeof article!=='object'||'query' in article||'answer' in article||'evidence_list' in article)throw new Error(`Item ${index+1} is not a corpus article. Load corpus.json, not the questions file.`);
  if(typeof article.title!=='string'||!article.title.trim()||typeof article.body!=='string'||!article.body.trim())throw new Error(`Article ${index+1} needs a title and body containing text.`);
  const result={title:article.title.trim(),body:article.body};
  for(const key of ['source','published_at','author','category','url']){
   if(article[key]!=null&&typeof article[key]!=='string')throw new Error(`Article ${index+1} has an invalid ${key}.`);
   if(article[key])result[key]=article[key];
  }
  return result;
 });
}
export function parseQuestions(value){
 if(!Array.isArray(value)||!value.length)throw new Error('The question file must contain a nonempty array.');
 return value.map((item,index)=>{
  const query=item?.query;
  if(typeof query!=='string'||!query.trim())throw new Error(`Question ${index+1} needs text in its query field.`);
  const answer=item?.answer;
  if(typeof answer!=='string'||!answer.trim())throw new Error(`Question ${index+1} needs text in its answer field.`);
  return {query:query.trim(),answer:answer.trim()};
 });
}
/**
 * @returns {Promise<Array<{index:number,question:string,answer:string,articleIds:string[]}>>}
 */
export async function buildQuestionCatalogue(questionFile,corpusFile){
 const queries=parseQuestions(questionFile);
 const articles=parseCorpus(corpusFile);
 const sourceIds=new Map();
 await Promise.all(articles.map(async(article,index)=>{
  if(typeof article.url!=='string'||!article.url.trim())throw new Error(`Corpus article ${index+1} needs a source URL to match questions.`);
  const id=await articleId(article);
  if(sourceIds.has(article.url))throw new Error('The corpus has duplicate source URLs.');
  sourceIds.set(article.url,id);
 }));
 return questionFile.flatMap((item,index)=>{
  if(typeof item.question_type!=='string'||!item.question_type.trim())throw new Error(`Question ${index+1} needs a question type.`);
  if(item.question_type==='null_query')return [];
  if(!Array.isArray(item.evidence_list)||!item.evidence_list.length)throw new Error(`Question ${index+1} needs supporting-source metadata.`);
  const urls=item.evidence_list.map(evidence=>{
   if(typeof evidence?.url!=='string'||!evidence.url.trim())throw new Error(`Question ${index+1} has an invalid supporting-source URL.`);
   return evidence.url;
  });
  const articleIds=new Set();
  for(const url of urls){
   const id=sourceIds.get(url);
   if(id===undefined)return [];
   articleIds.add(id);
  }
  return [{index,question:queries[index].query,answer:queries[index].answer,articleIds:[...articleIds]}];
 });
}
/**
 * @param {Awaited<ReturnType<typeof buildQuestionCatalogue>>} catalogue
 * @param {ReadonlyArray<{id:string}>} documents
 */
export function questionsForDocuments(catalogue,documents){
 const loadedIds=new Set(documents.map(document=>document.id));
 return catalogue.filter(question=>question.articleIds.length>0&&question.articleIds.every(id=>loadedIds.has(id)));
}
/**
 * @template T
 * @param {T[]} source
 * @param {number} count
 * @param {'first'|'random'} selection
 * @param {number} [seed]
 */
export function selectItems(source,count,selection,seed=42){
 if(!Array.isArray(source))throw new Error('Choose an array to sample.');
 if(!Number.isInteger(count)||count<1)throw new Error('Choose a positive sample size.');
 const items=[...source];
 if(selection==='random'){
  if(!Number.isInteger(seed)||seed<0||seed>4294967295)throw new Error('Choose a valid sampling seed.');
  let state=seed;
  for(let i=items.length-1;i>0;i--){state=(Math.imul(state,1664525)+1013904223)>>>0;const j=Math.floor(state/4294967296*(i+1));[items[i],items[j]]=[items[j],items[i]];}
 }else if(selection!=='first')throw new Error('Invalid selection method.');
 return items.slice(0,count);
}
export const selectArticles=selectItems;
