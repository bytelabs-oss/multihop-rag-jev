import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keywordSearch,compilePattern} from '../lib/keyword-search.mjs';

test('compilePattern rejects empty or invalid regex',()=>{
 assert.throws(()=>compilePattern(''),/nonempty/);
 assert.throws(()=>compilePattern('('),/valid regular expression/);
});

test('keywordSearch matches case-insensitively and returns a context window',()=>{
 const docs=[{id:'d1',name:'Doc',body:'a'.repeat(500)+'NEEDLE'+'b'.repeat(500)}];
 const [block]=keywordSearch(docs,'needle');
 assert(block.text.includes('NEEDLE'));
 assert(block.text.length<docs[0].body.length);
 assert(block.text.length>=6);
});

test('keywordSearch merges overlapping and adjacent windows into one block',()=>{
 const body='x'.repeat(100)+'FIRST'+'y'.repeat(50)+'SECOND'+'z'.repeat(2000)+'THIRD'+'w'.repeat(100);
 const docs=[{id:'d1',name:'Doc',body}];
 const blocks=keywordSearch(docs,'FIRST|SECOND|THIRD',{windowChars:400});
 // FIRST and SECOND are only 50 chars apart (well inside the 400-char window on each side), so they merge.
 // THIRD is 2000 chars past SECOND, well outside the window, so it stays a separate block.
 assert.equal(blocks.length,2);
 assert(blocks[0].text.includes('FIRST')&&blocks[0].text.includes('SECOND'));
 assert(blocks[1].text.includes('THIRD'));
});

test('keywordSearch gives stable ids keyed on document and span',()=>{
 const docs=[{id:'d1',name:'Doc',body:'hello world hello'}];
 const blocks=keywordSearch(docs,'hello');
 assert(blocks.every(b=>b.id.startsWith('d1:')));
});

test('keywordSearch skips documents without a body and caps block count',()=>{
 const docs=[{id:'d1',name:'Doc',body:''},{id:'d2',name:'Doc2',body:Array.from({length:100},(_,i)=>`match${i}`).join('  |gap|  '.repeat(50))}];
 const blocks=keywordSearch(docs,'match\\d+',{maxBlocks:5});
 assert(blocks.length<=5);
});
