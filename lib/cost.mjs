import {tokenUsage} from './usage.mjs';
// USD per million tokens. Verified against vendor catalogs on 2026-09-18.
export const defaultRates={
 'jev-latest':{input:0.042,cached:0.042,output:0},
 'openai/gpt-5-mini':{input:0.25,cached:0.025,output:2},
};
const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
/** @param {any[]} calls @param {Record<string,{input:number|null,cached:number|null,output:number|null}>} rates */
export function estimateCost(calls,rates=defaultRates){
 let usd=0,missing=0;
 for(const call of calls){
  const rate=rates[call.model],u=tokenUsage(call.usage);
  if(!rate||!valid(rate.input)||!valid(rate.output)||!valid(rate.cached)||u.input===null||(u.output===null&&rate.output!==0)||(u.cached!==null&&u.cached>u.input)){missing++;continue;}
  const cached=u.cached??0;
  usd+=((u.input-cached)*rate.input+cached*rate.cached+(u.output??0)*rate.output)/1e6;
 }
 return {usd,missing,count:calls.length};
}
export function formatCost({usd,missing,count}){
 if(count&&missing===count)return 'Unreported';
 const amount=usd>0&&usd<0.000001?'<$0.000001':`$${usd.toFixed(6)}`;
 return amount+(missing?' + unreported':'');
}
