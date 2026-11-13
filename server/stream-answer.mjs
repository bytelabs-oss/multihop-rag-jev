// Consume the full provider stream so failures, usage and finish status are retained.
export async function streamAnswer(streamText,args,onText){
 const started=Date.now();let text='',firstTextMs;let finishReason;
 const result=streamText(args);
 for await(const part of result.fullStream){
  if(args.abortSignal?.aborted)throw new Error('Run cancelled.');
  if(part.type==='error')throw part.error;
  if(part.type==='abort')throw new Error('Run cancelled.');
  if(part.type==='text-delta'){
   if(firstTextMs===undefined)firstTextMs=Date.now()-started;
   text+=part.text;onText(part.text,firstTextMs);
  }
  if(part.type==='finish')finishReason=part.finishReason;
 }
 if(args.abortSignal?.aborted)throw new Error('Run cancelled.');
 if(!finishReason)throw new Error('Answer stream ended before completion.');
 return {text,usage:await result.totalUsage,finishReason,firstTextMs};
}
