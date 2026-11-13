import {sumUsage} from './usage.mjs';
import {estimateCost} from './cost.mjs';
// Blended USD per million tokens actually paid for a group of calls, mixing
// each call's input/cached/output rate. Null when cost or token count is
// unknown, or when the group made no calls (nothing was paid, not a $0 rate).
const ratePerMtok=(cost,tokens)=>cost==null||tokens==null||!tokens?null:cost/tokens*1e6;
export function comparisonRow(run,rates){
 const calls=run.calls||[],jev=calls.filter(c=>['relevance','contribution'].includes(c.stage)),gpt=calls.filter(c=>['answer','keywords','rewrite'].includes(c.stage));
 const answer=calls.filter(c=>c.stage==='answer');
 const tokens=c=>{const t=sumUsage(c).total;return t.missing||run.usageIncomplete?null:t.value;};
 const cost=c=>{const v=estimateCost(c,rates);return v.missing||run.usageIncomplete?null:v.usd;};
 const jevTokens=tokens(jev),gptTokens=tokens(gpt),jevCost=cost(jev),gptCost=cost(gpt);
 const jevRatePerMtok=ratePerMtok(jevCost,jevTokens),gptRatePerMtok=ratePerMtok(gptCost,gptTokens);
 return {run,retrieved:run.candidates.length,kept:run.context?run.ranked.filter(c=>c.kept).length:null,answerCalled:answer.length>0,answerTokens:answer.length?tokens(answer):null,answerCost:answer.length?cost(answer):null,totalTokens:tokens(calls),jevTokens,gptTokens,jevCost,gptCost,jevRatePerMtok,gptRatePerMtok,cost:cost(calls),seconds:run.elapsedMs==null?null:run.elapsedMs/1000,complete:run.phase==='done'};
}
