import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Plugin } from 'vite';

type Session={child:ReturnType<typeof spawn>|null;queue:Promise<void>;receive?: (event:any)=>void;lastSeen:number;closed:boolean;buffer:string};
export function documentsPlugin():Plugin{
 return {name:'local-document-libraries',apply:'serve',configureServer(server){
  const sessions=new Map<string,Session>();
  function release(id:string){const s=sessions.get(id);if(!s)return;s.closed=true;s.child?.kill();s.receive?.({type:'error',message:'Local session ended.'});sessions.delete(id);}
  const sweep=setInterval(()=>{for(const [id,s] of sessions)if(!s.receive&&Date.now()-s.lastSeen>600000)release(id);},60000);
  server.httpServer?.once('close',()=>{clearInterval(sweep);for(const id of sessions.keys())release(id);});
  function childFor(s:Session){
   if(s.child)return s.child;
   const child=spawn(resolve('.venv/bin/python'),[resolve('server/documents.py')],{stdio:['pipe','pipe','ignore'],env:{...process.env,PYTHONUNBUFFERED:'1'}});
   s.child=child;s.buffer='';
   child.stdout.on('data',data=>{s.buffer+=data.toString();let at;while((at=s.buffer.indexOf('\n'))>=0){const line=s.buffer.slice(0,at);s.buffer=s.buffer.slice(at+1);try{s.receive?.(JSON.parse(line));}catch{/* Ignore library output. */}}});
   child.stdin.on('error',()=>{});
   const failed=()=>{if(s.child!==child)return;s.child=null;s.receive?.({type:'error',message:'Local processing stopped. Retry the request.'});};
   child.on('error',failed);child.on('close',failed);return child;
  }
  server.middlewares.use('/api/documents',async(req,res)=>{
   res.setHeader('Cache-Control','no-store');const host=req.headers.host||'';
   if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)||req.headers.origin&&!new Set([`http://${host}`,`https://${host}`]).has(req.headers.origin)){res.writeHead(403);res.end();return;}
   if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({configured:existsSync(resolve('.venv/bin/python')),chunker:'Docling HybridChunker',embedding:'BAAI/bge-small-en-v1.5',retrieval:'Qdrant in-memory BM25 + cosine + RRF'}));return;}
   if(req.method!=='POST'){res.writeHead(405);res.end();return;}
   const sessionHeader=req.headers['x-atlas-session'];
   if(sessionHeader&&(!/^[a-f0-9-]{36}$/.test(String(sessionHeader)))){res.writeHead(400);res.end();return;}
   const id=String(sessionHeader||randomUUID());let input:any;
   try{const pieces:Buffer[]=[];for await(const piece of req)pieces.push(Buffer.from(piece));input=JSON.parse(Buffer.concat(pieces).toString('utf8'));if(!['ingest','ingest-article','search','project','clear','release','ping'].includes(input.mode))throw new Error();}
   catch{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Invalid local processing request.'}));return;}
   if(input.mode==='release'){release(id);res.end();return;}
   if(input.mode==='ping'){const s=sessions.get(id);if(s)s.lastSeen=Date.now();res.end();return;}
   if(!existsSync(resolve('.venv/bin/python'))){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Install the local Python dependencies.'}));return;}
   let session=sessions.get(id);
   if(!session){session={child:null,queue:Promise.resolve(),lastSeen:Date.now(),closed:false,buffer:''};sessions.set(id,session);}
   const s=session;s.lastSeen=Date.now();
   s.queue=s.queue.then(()=>new Promise<void>(done=>{
    if(res.destroyed){done();return;}
    if(s.closed){res.writeHead(409);res.end();done();return;}
    res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.flushHeaders();
    let finished=false;
    const heartbeat=setInterval(()=>{if(!res.destroyed)res.write('{"type":"heartbeat"}\n');},15000);
    const finish=()=>{if(finished)return;finished=true;clearInterval(heartbeat);s.receive=undefined;s.lastSeen=Date.now();if(!res.destroyed)res.end();done();if(!sessionHeader)release(id);};
    s.receive=event=>{if(!res.destroyed)res.write(JSON.stringify(event)+'\n');if(event.type==='done'||event.type==='error')finish();};
    const child=childFor(s);
    res.once('close',()=>{if(!finished){s.child=null;child.kill();finish();}});
    // Keep stdin open for subsequent requests in this tab.
    child.stdin!.write(JSON.stringify(input)+'\n');input=null;
   }));
  });
 }};
}
