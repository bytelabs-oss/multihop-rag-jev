export type Chunk = {id:string;index:number;text:string;start:number;end:number;page:number|null;vector:number[];model?:string;pageEnd?:number|null;chunker?:string;tokenCount?:number;modelTokenLimit?:number;body?:string;headings?:string[];sourceRefs?:string[];section?:string};
export type Doc = {id:string;name:string;size:number;count:number;created:string;chunks:Chunk[];body?:string};
// Cached documents saved before raw-body persistence lack `body`; reconstruct it from chunk text so keyword search still works.
export const docBody=(doc:Pick<Doc,'body'|'chunks'>)=>doc.body??doc.chunks.map(c=>c.body??c.text).join('\n\n');
export const COLORS=['#a3b84b','#ac9cde','#db9565','#70b9b0','#d47591','#7da1d1'];
export type SourceText = {text:string;pages:{page:number;start:number;end:number}[]};
export const similarity=(a:number[],b:number[])=>a.reduce((sum,v,i)=>sum+v*(b[i]||0),0);
