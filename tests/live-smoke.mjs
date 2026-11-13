// Manual smoke test: sends only the synthetic passages below to model providers.
import assert from 'node:assert/strict';
const settings={topK:20,semanticThreshold:.5,threshold:.5};
async function events(path,payload){
 const response=await fetch(`http://localhost:5173${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 assert(response.ok,`HTTP ${response.status}`);
 const result=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
 const failure=result.find(e=>e.type==='error');assert(!failure,failure?.message||failure?.error);
 return result;
}
const data=Buffer.from('# Handbook\n\n## Retention\nRecords are retained for thirty days.\n\n## Exports\nSecurity approves every data export.\n\n## Cafeteria\nThe cafeteria serves noodles on Fridays.').toString('base64');
const ingest=await events('/api/documents',{mode:'ingest',name:'handbook.md',data});
const chunks=ingest.find(e=>e.type==='done').chunks.map((c,i)=>({...c,id:`smoke:${i}`,docId:'smoke',docName:'handbook.md'}));
assert.equal(chunks.length,3);assert(chunks.every(c=>c.chunker==='docling.HybridChunker'&&c.vector.length===384));
console.log('PASS: actual Docling headings, chunks, FastEmbed vectors');
const question='How long are records retained and who approves exports?';
const search=await events('/api/documents',{mode:'search',question,chunks,topK:settings.topK,semanticThreshold:settings.semanticThreshold});
const candidates=search.find(e=>e.type==='done').candidates;
assert(candidates.some(c=>c.text.includes('thirty days')));assert(candidates.some(c=>c.text.includes('Security')));
console.log('PASS: actual Qdrant hybrid search finds both required passages');
const pipeline=await events('/api/experiment',{question,candidates,settings});
const selected=pipeline.find(e=>e.type==='selected');assert(selected);
const kept=new Set(selected.ranked.filter(c=>c.kept).map(c=>c.id));
assert(candidates.some(c=>kept.has(c.id)&&c.text.includes('thirty days')));
assert(candidates.some(c=>kept.has(c.id)&&c.text.includes('Security')));
assert(!selected.context.prompt.includes('noodles'));
assert(pipeline.find(e=>e.type==='answer')?.answer?.includes('[C'));
console.log('PASS: live JEV selected required evidence, dropped unrelated content, and answer model cited evidence');
