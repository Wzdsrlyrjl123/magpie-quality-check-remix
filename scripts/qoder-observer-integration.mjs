import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const binary = process.env.MAGPIE_BINARY;
if (!binary) throw Error('Set MAGPIE_BINARY');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-id-fixture-'));
const host = path.join(dir, 'host'), config = path.join(host, 'data');
await fs.mkdir(config, { recursive: true });
await fs.writeFile(path.join(host, '.portable'), '');
const exe = path.join(host, process.platform === 'win32' ? 'magpie.exe' : 'magpie');
await fs.copyFile(binary, exe);
const fixture = path.join(dir, 'fixture');
await fs.mkdir(fixture);
await fs.writeFile(path.join(fixture,'package.json'),JSON.stringify({name:'fixture',type:'module',main:'index.mjs'}));
const vendor=pathToFileURL(path.resolve(import.meta.dirname,'../adapters/qoder/vendor.mjs')).href;
await fs.writeFile(path.join(fixture,'index.mjs'), `import { _observerTest as t } from ${JSON.stringify(vendor)}; export default {id:'fixture',server:async()=>({auth:{provider:'qoder',methods:[],loader:async()=>({apiKey:'fixture',baseURL:'https://fixture.invalid/v1',fetch:async(_u,init)=>{const b=JSON.parse(init.body);const wire='data: '+JSON.stringify({statusCodeValue:200,body:JSON.stringify({model:'raw-fixture-model',choices:[{delta:{content:'ok'},finish_reason:'stop'}]})})+'\\n\\ndata: '+JSON.stringify({statusCodeValue:200,body:'[DONE]'})+'\\n\\n';return t.answer(await t.opened(new Response(wire),[]),b,'fixture-served',${JSON.stringify(dir)});}})},provider:{id:'qoder',models:async()=>({solo:{id:'solo',name:'Solo'}})}})};`);
await fs.writeFile(path.join(config, 'plugins.json'), JSON.stringify({plugins:[{spec:fixture}]}));
await fs.writeFile(path.join(config, 'plugin-auth.json'), JSON.stringify({qoder:{type:'api',key:'fixture'}}));
await fs.writeFile(path.join(config, 'providers.json'), JSON.stringify({providers:[]}));
const port = await new Promise(resolve => { const s=http.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));}); });
const base=`http://127.0.0.1:${port}`;
const child=spawn(exe,['web','--addr','127.0.0.1:0','--no-open','--gateway'],{env:{...process.env,HOME:dir,USERPROFILE:dir,XDG_CONFIG_HOME:path.join(dir,'config'),XDG_CACHE_HOME:path.join(dir,'cache'),MAGPIE_BUN:process.env.MAGPIE_BUN || path.join(os.homedir(),'.cache','magpie','bun','1.4.4','magpie-bun.exe'),MAGPIE_WEB_KEY:'fixture-key-123456789',MAGPIE_ADDR:`127.0.0.1:${port}`},stdio:['pipe','pipe','pipe'],windowsHide:true});
let log='';child.stderr.on('data',b=>{log+=b});child.stdout.on('data',b=>{log+=b});
let backend;
try {
  const deadline=Date.now()+15000;let models;
  while(Date.now()<deadline){try{const r=await fetch(base+'/v1/models',{signal:AbortSignal.timeout(1500)});if(r.ok){models=await r.json();if(models.data.some(x=>x.id==='qoder/solo'))break}}catch{} await new Promise(r=>setTimeout(r,150));}
  assert.ok(models?.data.some(x=>x.id==='qoder/solo'),`fixture missing: ${log.slice(-2000)}`);
  const web=log.match(/http:\/\/127\.0\.0\.1:\d+\/\?k=fixture-key-123456789/)?.[0];
  if(web){const exchange=await fetch(web,{redirect:'manual'});const cookie=exchange.headers.get('set-cookie')?.split(';')[0];const p=await fetch(new URL('/api/plugins',web),{headers:{cookie},signal:AbortSignal.timeout(10000)});assert.match(await p.text(),/fixture/);}
  for(const stream of [false,true]){
    const r=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer magpie','content-type':'application/json'},body:JSON.stringify({model:'qoder/solo',stream,messages:[{role:'user',content:'fixture'}]}),signal:AbortSignal.timeout(5000)});
    const body=await r.text();assert.equal(r.status,200,body);
    const value=JSON.parse(stream?body.split('\n').find(x=>x.startsWith('data: {')).slice(6):body);
    assert.match(value.id,/^chatcmpl-/);
    const receipt=JSON.parse(await fs.readFile(path.join(dir,'upstream-observations',value.id+'.json'),'utf8'));
    assert.equal(receipt.response_id,value.id);assert.equal(receipt.response_model,'raw-fixture-model');assert.deepEqual(receipt.models,['raw-fixture-model']);
  }
  const qc=process.env.QUALITY_CHECK_BINARY || path.resolve(import.meta.dirname,'../bin',process.platform==='win32'?'quality-check.exe':'quality-check');
  const gate=path.join(dir,'gate.js');await fs.writeFile(gate,'export function onRequest(body) { return body; }\n');
  backend=spawn(qc,['-data',dir,'-gate',gate,'-owned'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let output='',errors='';backend.stderr.on('data',b=>{errors+=b});
  const info=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('backend startup timeout: '+errors.slice(-1000))),10000);backend.stdout.on('data',b=>{output+=b;const i=output.indexOf('\n');if(i>=0){clearTimeout(timer);try{resolve(JSON.parse(output.slice(0,i)))}catch(e){reject(e)}}});backend.once('error',reject);backend.once('exit',code=>reject(Error('backend exited '+code+': '+errors.slice(-1000))));});
  const api=async(p,body)=>{const r=await fetch(info.origin+p,{method:body?'POST':'GET',headers:{authorization:'Bearer '+info.control,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error(await r.text());return r.json();};
  await api('/api/config',{gateway_url:base,gateway_key:'magpie',daily_limit:120,gate_mode:'observe'});
  await api('/api/route/check',{model:'qoder/solo'});
  let route;const until=Date.now()+15000;
  while(Date.now()<until){const state=await api('/api/state');route=state.state.routes?.at(-1);if(route)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(route,'route probe did not finish');assert.equal(route.upstream_status,'observed',JSON.stringify(route));assert.equal(route.upstream_model,'raw-fixture-model');
  assert.notEqual(route.served,'raw-fixture-model');assert.notEqual(route.body_model,'raw-fixture-model');assert.equal(route.provider,'qoder');
  console.log('PASS: Magpie JSON/SSE IDs match raw Qoder receipts and Go route probe consumes the observation');
} catch(e) { console.error(log.slice(-4000)); throw e; } finally {for(const p of [backend,child].filter(Boolean)){p.stdin.end();p.kill();if(p.exitCode===null)await Promise.race([once(p,'exit'),new Promise(r=>setTimeout(r,3000))]);}await fs.rm(dir,{recursive:true,force:true});}
