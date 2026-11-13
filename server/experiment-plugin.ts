import type { Plugin } from 'vite';
import { config } from 'dotenv';
import { TypeSafeClient, type EntryType, type Questions } from '@typesafe-ai/sdk';
import { generateText, streamText } from 'ai';
import { streamAnswer } from './stream-answer.mjs';
import { runPipeline, validateInput, JEV_MODEL, LLM_MODEL } from './pipeline.mjs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';

// Read the local TypeSafe and answer-model credentials without copying them into this project.
const envSources=[resolve('.env.local'),resolve('../.env.local')];
for(const path of envSources)config({path,quiet:true});

let typeSafeClient:TypeSafeClient|undefined;
function getTypeSafeClient(){
 if(!typeSafeClient)typeSafeClient=new TypeSafeClient();
 return typeSafeClient;
}
function evaluateWithTypeSafe({
 state,
 questions,
 abortSignal,
 maxRetries,
}:{
 state:EntryType;
 questions:Questions;
 abortSignal?:AbortSignal;
 maxRetries?:number;
}){
 return getTypeSafeClient().systemOne(
  {model:JEV_MODEL,state,questions},
  {signal:abortSignal,retry:{maxRetries:maxRetries??2}},
 );
}

export function experimentPlugin():Plugin {
 return {name:'local-jev-experiment',apply:'serve',configureServer(server){
  server.middlewares.use('/api/experiment',async(req:IncomingMessage,res:ServerResponse)=>{
   res.setHeader('Cache-Control','no-store');
   const host=req.headers.host||'';
   if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)){res.writeHead(403);res.end('Local requests only.');return;}
   if(req.headers.origin&&!new Set([`http://${host}`,`https://${host}`]).has(req.headers.origin)){res.writeHead(403);res.end('Invalid origin.');return;}
   if(req.method==='GET'){
    const jevConfigured=!!process.env.TYPESAFE_API_KEY;
    const answerConfigured=!!process.env.AI_GATEWAY_API_KEY;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({configured:jevConfigured&&answerConfigured,jevConfigured,answerConfigured,jevModel:JEV_MODEL,llmModel:LLM_MODEL}));
    return;
   }
   if(req.method!=='POST'){res.writeHead(405);res.end();return;}
   let parsed;
   try{
    let size=0;const pieces:Buffer[]=[];
    for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;pieces.push(b);}
    parsed=validateInput(JSON.parse(Buffer.concat(pieces).toString('utf8')));
   }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e instanceof Error?e.message:'Invalid request.'}));return;}
   if(((parsed.mode==='jev'||parsed.mode==='keyword-jev')&&!process.env.TYPESAFE_API_KEY)||!process.env.AI_GATEWAY_API_KEY){
    res.writeHead(503,{'Content-Type':'application/json'});
    res.end(JSON.stringify({error:'TYPESAFE_API_KEY and AI_GATEWAY_API_KEY are both required in the local experiment environment.'}));
    return;
   }
   res.writeHead(200,{'Content-Type':'application/x-ndjson','X-Content-Type-Options':'nosniff'});res.flushHeaders();
   const controller=new AbortController();
   res.on('close',()=>{if(!res.writableEnded)controller.abort();});
   const emit=(event:unknown)=>{if(!res.destroyed)res.write(JSON.stringify(event)+'\n');};
   try{await runPipeline(parsed,{evaluate:evaluateWithTypeSafe,generateText,generateAnswer:(args:any,onText:any)=>streamAnswer(streamText,args,onText)},emit,controller.signal);}
   catch(e){
    // Do not log or return provider errors: they may contain request passages.
    const status=(e as {status?:number;statusCode?:number})?.status??(e as {statusCode?:number})?.statusCode;
    const detail=String((e as Error)?.message);
    const code=controller.signal.aborted?'cancelled':status===401||status===403?'credentials':status===429?'rate_limit':/context|token|too large|maximum.*length/i.test(detail)?'context_window':/answer was cut short|answer model returned no text/i.test(detail)?'answer_incomplete':'provider';
    const message=code==='cancelled'?'The run was stopped.':code==='credentials'?'A configured model credential was rejected.':code==='context_window'?'The selected evidence exceeds a provider input window. No evidence was silently dropped.':code==='answer_incomplete'?'The answer model did not produce a complete answer.':code==='rate_limit'?'A model rate limit was reached. Wait and retry.':'The JEV or answer request failed. Inspect any completed stages, then retry.';
    emit({type:'error',error:message,code});
   }finally{res.end();}
  });
 }};
}
