export const PIPELINE_ID='sentence256-overlap25-llama0.14.24-bge-small-en-v1.5-v1';
export function validateCache(value){
 if(value?.format!=='atlas-embeddings'||value.version!==1||!Array.isArray(value.documents))throw new Error('Choose an Atlas embedding cache exported by this app.');
 const ids=new Set();
 for(const doc of value.documents){
  if(typeof doc.id!=='string'||!doc.id||ids.has(doc.id)||typeof doc.name!=='string'||!Array.isArray(doc.chunks)||!doc.chunks.length)throw new Error('Invalid cached document.');
  ids.add(doc.id);
  const chunkIds=new Set();
  for(const [i,c] of doc.chunks.entries()){
   if(typeof c.id!=='string'||c.id!==`${doc.id}:${i}`||chunkIds.has(c.id)||c.index!==i||typeof c.text!=='string'||!c.text.trim()||c.model!=='BAAI/bge-small-en-v1.5'||!Array.isArray(c.vector)||c.vector.length!==384||!c.vector.every(v=>typeof v==='number'&&Number.isFinite(v)))throw new Error('Cache has invalid chunks or incompatible embeddings.');
   chunkIds.add(c.id);
  }
 }
 return value.documents;
}
export const cachePayload=documents=>({format:'atlas-embeddings',version:1,documents});
function database(){return new Promise((resolve,reject)=>{
 const request=indexedDB.open('atlas-embeddings',1);
 request.onupgradeneeded=()=>{request.result.createObjectStore('documents',{keyPath:'id'});request.result.createObjectStore('projections');};
 request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
 });}
async function transact(store,mode,action){
 const db=await database();
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction(store,mode);let result;const request=action(tx.objectStore(store));if(request)request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Cache operation cancelled.'));});}
 finally{db.close();}
}
export const saveDocument=doc=>transact('documents','readwrite',store=>store.put(doc));
export const savedDocument=id=>transact('documents','readonly',store=>store.get(id));
export async function savedDocuments(){const docs=await transact('documents','readonly',store=>store.getAll());return validateCache(cachePayload(docs)).sort((a,b)=>String(a.created).localeCompare(String(b.created)));}
export const deleteSavedDocument=id=>transact('documents','readwrite',store=>store.delete(id));
export async function clearSavedDocuments(){await transact('documents','readwrite',store=>store.clear());await transact('projections','readwrite',store=>store.clear());}
export const savedProjection=key=>transact('projections','readonly',store=>store.get(key));
export const saveProjection=(key,coords)=>transact('projections','readwrite',store=>store.put(coords,key));
export async function articleId(article){
 const bytes=new TextEncoder().encode(JSON.stringify([PIPELINE_ID,article.title,article.source??null,article.published_at??null,article.body]));
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 return 'corpus-'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
