const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
export function tokenUsage(usage){
 const input=number(usage?.input_tokens??usage?.inputTokens);
 const output=number(usage?.output_tokens??usage?.outputTokens);
 return {input,output,total:number(usage?.total_tokens??usage?.totalTokens)??(input!==null&&output!==null?input+output:null),cached:number(usage?.inputTokenDetails?.cacheReadTokens),reasoning:number(usage?.outputTokenDetails?.reasoningTokens)};
}
export function sumUsage(calls){
 const rows=calls.map(c=>tokenUsage(c.usage));
 return Object.fromEntries(['input','output','total'].map(key=>[key,{value:rows.reduce((sum,r)=>sum+(r[key]??0),0),missing:rows.filter(r=>r[key]===null).length}]));
}
