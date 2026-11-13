import { type Chunk } from './documents';
export type ComparisonMode='hybrid'|'jev'|'keyword'|'keyword-jev';
export const modeLabels:Record<ComparisonMode,string>={hybrid:'Hybrid baseline',jev:'Hybrid + JEV',keyword:'Keyword search (rg)',"keyword-jev":'Keyword search (rg) + JEV'};
export type Settings = { topK:number; semanticThreshold:number; threshold:number; retryOnEmpty?:boolean };
export const defaultSettings:Settings={topK:20,semanticThreshold:.5,threshold:.5};
export type Candidate = Omit<Chunk,'vector'> & {docId:string;docName:string;retrievalRank:number;similarity:number;bm25Score:number;hybridScore:number;semanticRank:number|null;lexicalRank:number|null;label:string;retrievalReason?:string};
export type Ranked = {id:string;label:string;score:number|null;rank:number;kept:boolean;reason:string;noveltyScore?:number|null};
export type Prompt = {system:string;prompt:string};
export type ModelCall = {id:string;stage:'relevance'|'contribution'|'answer'|'keywords'|'rewrite';model:string;status:'running'|'complete'|'failed'|'cancelled';request:any;response?:any;usage?:any;ms?:number;firstTextMs?:number;finishReason?:string};
export type Run = {
 attempt?:number;
 usageIncomplete?:boolean;
 retryOf?:string;retrievalQuery?:string;
 mode:ComparisonMode;groupId:string;elapsedMs?:number;searchTerms?:string[];
 calls?:ModelCall[]; retrievalTimings?:Record<string,number>;
 id:string;question:string;referenceAnswer?:string;settings:Settings;candidates:Candidate[];ranked:Ranked[];
 phase:'searching'|'embedding'|'retrieved'|'ranking'|'selecting'|'answering'|'done'|'error'|'cancelled';
 answer?:string;error?:string;questions?:Record<string,unknown>;jevAnswers?:unknown;
 context?:Prompt;jevUsage?:unknown;llmUsage?:unknown;jevMs?:number;llmMs?:number;retrievalMs?:number;selection?:unknown[];progress?:string;
};
export function parseEvents(buffer:string){const lines=buffer.split('\n');const rest=lines.pop()!;return {events:lines.filter(Boolean).map(line=>JSON.parse(line)),rest};}

export const runLabel=(run:Run)=>modeLabels[run.mode]+(run.retryOf?' · retry':'')+(run.attempt&&run.attempt>1?` · attempt ${run.attempt}`:'');
