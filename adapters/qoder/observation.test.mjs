import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { observation, saveObservation } from './observation.mjs';
import { _observerTest } from './vendor.mjs';
import plugin from './index.mjs';

const raw = chunks => new Response(chunks.map(c=>`data: ${JSON.stringify({statusCodeValue:200,body:JSON.stringify(c)})}\n\n`).join('')+'data: '+JSON.stringify({statusCodeValue:200,body:'[DONE]'})+'\n\n');
const read = async (dir,id) => JSON.parse(await readFile(path.join(dir,'upstream-observations',id+'.json'),'utf8'));
test('raw model only, response id association, JSON and stream',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'qoder-obs-test-'));
 try {
  for (const stream of [false,true]) {
   const opened=await _observerTest.opened(raw([{model:' first ',choices:[{delta:{content:'hi'}}]},{model:'last',choices:[{delta:{},finish_reason:'stop'}]}]),[]);
   const res=await _observerTest.answer(opened,{stream,model:'request-name'},'served-name',dir);
   const text=await res.text(); const chunk=JSON.parse(stream?text.split('\n')[0].slice(6):text);
   assert.equal(chunk.model,'served-name');
   const receipt=await read(dir,chunk.id);
   assert.deepEqual(Object.keys(receipt).sort(),['schema','response_id','provider','sent_model','response_model','models','conflict','source','captured_at'].sort());
   assert.equal(receipt.response_id,chunk.id); assert.equal(receipt.sent_model,''); assert.equal(receipt.response_model,'last');
   assert.deepEqual(receipt.models,['first','last']); assert.equal(receipt.conflict,true);
   assert.ok(!JSON.stringify(receipt).includes('request-name')); assert.ok(!JSON.stringify(receipt).includes('served-name'));
  }
 } finally {await rm(dir,{recursive:true,force:true})}
});
test('absent, invalid, bounded and terminal precedence',()=>{
 const o=observation(); for(const model of [null,'', 'x'.repeat(201), 4])o.observe({model});
 assert.doesNotThrow(()=>{o.observe({model:'valid',choices:{}});o.observe({get model(){throw Error('bad')}})});
 const empty=observation();
 assert.equal(empty.receipt('x').response_model,''); assert.deepEqual(empty.receipt('x').models,[]);
 for(let i=0;i<18;i++)empty.observe({model:`m${i}`,choices:[{finish_reason:i===17?'stop':null}]});
 const r=empty.receipt('x'); assert.equal(r.response_model,'m17'); assert.equal(r.models.length,16); assert.equal(r.conflict,true);
});
test('cleanup and failure cannot break output',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'qoder-obs-test-'));
 try {
  const o=observation(); await saveObservation('first',o,dir);
  const old=path.join(dir,'upstream-observations','first.json');await utimes(old,new Date(0),new Date(0));
  await saveObservation('second',o,dir);assert.deepEqual(await readdir(path.dirname(old)),['second.json']);
  const file=path.join(dir,'not-a-dir');await writeFile(file,'x');
  const opened=await _observerTest.opened(raw([{choices:[{delta:{content:'ok'},finish_reason:'stop'}]}]),[]);
  const res=await _observerTest.answer(opened,{stream:false,model:'x'},'x',file);assert.equal(res.status,200);
  assert.equal(typeof plugin.server,'function');
 } finally {await rm(dir,{recursive:true,force:true})}
});
