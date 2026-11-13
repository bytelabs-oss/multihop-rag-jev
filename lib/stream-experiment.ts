import {parseEvents} from './experiment';
export class ExperimentRequestError extends Error {
 constructor(message:string,public readonly code:string,public readonly status?:number){
  super(message);this.name='ExperimentRequestError';
 }
}
export async function streamExperiment(payload:any,onEvent:(event:any)=>void,signal:AbortSignal){
 const response=await fetch('/api/experiment',{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify(payload)});
 if(!response.ok){const data=await response.json() as {error?:string;code?:string};throw new ExperimentRequestError(data.error||'The experiment request failed.',data.code||'http_error',response.status);}
 if(!response.body)throw new Error('No pipeline response was received.');
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',terminal:any;
 const apply=(event:any)=>{onEvent(event);if(['answer','rewritten','error'].includes(event.type))terminal=event;};
 try{while(true){const result=await reader.read();if(result.done)break;buffer+=decoder.decode(result.value,{stream:true});const parsed=parseEvents(buffer);buffer=parsed.rest;parsed.events.forEach(apply);}buffer+=decoder.decode();if(buffer.trim())apply(JSON.parse(buffer));}
 finally{await reader.cancel();}
 if(signal.aborted)throw new Error('Run cancelled.');
 if(!terminal)throw new Error('The response ended before the experiment completed.');
 if(terminal.type==='error')throw new ExperimentRequestError(terminal.error,terminal.code||'provider');
 return terminal;
}
