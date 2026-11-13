// A ripgrep-style search over raw, unchunked document text: the model supplies a
// regex pattern, this runs it literally (case-insensitive) against each document's
// full body, and returns each hit with surrounding context, merging overlapping or
// adjacent hits into one block the same way `rg -C` collapses nearby context lines.
const WINDOW_CHARS=400;
const MAX_BLOCKS=40;

export function compilePattern(pattern){
 if(typeof pattern!=='string'||!pattern.trim())throw new Error('Search pattern must be a nonempty string.');
 try{return new RegExp(pattern,'gi');}
 catch{throw new Error('Search pattern is not a valid regular expression.');}
}

/** @param {{id:string,name:string,body:string}[]} docs @param {string} pattern */
export function keywordSearch(docs,pattern,{windowChars=WINDOW_CHARS,maxBlocks=MAX_BLOCKS}={}){
 const re=compilePattern(pattern);
 const blocks=[];
 for(const doc of docs){
  if(!doc.body)continue;
  const spans=[];
  re.lastIndex=0;
  let match;
  while((match=re.exec(doc.body))){
   const start=Math.max(0,match.index-windowChars);
   const end=Math.min(doc.body.length,match.index+match[0].length+windowChars);
   spans.push({start,end});
   re.lastIndex=match.index+(match[0].length||1);
  }
  if(!spans.length)continue;
  spans.sort((a,b)=>a.start-b.start);
  let current=spans[0];
  for(const span of spans.slice(1)){
   if(span.start<=current.end){current.end=Math.max(current.end,span.end);}
   else{blocks.push({docId:doc.id,docName:doc.name,start:current.start,end:current.end,text:doc.body.slice(current.start,current.end)});current=span;}
  }
  blocks.push({docId:doc.id,docName:doc.name,start:current.start,end:current.end,text:doc.body.slice(current.start,current.end)});
 }
 return blocks.slice(0,maxBlocks).map(b=>({...b,id:`${b.docId}:${b.start}-${b.end}`}));
}
