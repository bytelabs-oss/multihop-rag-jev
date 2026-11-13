import { parseEvents } from './experiment';
let sessionId:string|undefined;
let indexedCorpus:string|undefined;
function session(){
 if(!sessionId){sessionId=crypto.randomUUID();
  const control=(mode:string)=>fetch('/api/documents',{method:'POST',headers:{'Content-Type':'application/json','X-Atlas-Session':sessionId!},body:JSON.stringify({mode}),keepalive:true}).catch(()=>{});
  const timer=setInterval(()=>control('ping'),30000);
  window.addEventListener('pagehide',()=>{clearInterval(timer);control('release');},{once:true});
 }
 return sessionId;
}
export async function localDocuments(payload:any,onProgress:(text:string)=>void,signal?:AbortSignal):Promise<any>{
 const reuse=payload.mode==='search'&&payload.corpusKey&&indexedCorpus===payload.corpusKey;
 const outgoing=reuse?{...payload,chunks:undefined}:payload;
 if(payload.mode==='clear')indexedCorpus=undefined;
 const response=await fetch('/api/documents',{method:'POST',headers:{'Content-Type':'application/json','X-Atlas-Session':session()},body:JSON.stringify(outgoing),signal});
 if(!response.ok){const data=await response.json() as {error?:string};throw new Error(data.error||'Local document processing failed.');}
 if(!response.body)throw new Error('No local processing response.');
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',result:any;
 const apply=(event:any)=>{if(event.type==='progress')onProgress(event.message);if(event.type==='error')throw new Error(event.message);if(event.type==='done')result=event;};
 try{while(true){const next=await reader.read();if(next.done)break;buffer+=decoder.decode(next.value,{stream:true});const parsed=parseEvents(buffer);buffer=parsed.rest;parsed.events.forEach(apply);}buffer+=decoder.decode();if(buffer.trim())apply(JSON.parse(buffer));}
 finally{await reader.cancel();}
 if(!result)throw new Error('Processing ended without a complete result.');
 if(result.needsIndex){indexedCorpus=undefined;if(reuse)return localDocuments(payload,onProgress,signal);throw new Error('The document index is unavailable. Retry the question.');}
 if(payload.mode==='search')indexedCorpus=payload.corpusKey;
 return result;
}
export async function encodeFile(file:File):Promise<string>{return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Could not read this file.'));reader.readAsDataURL(file);});}
