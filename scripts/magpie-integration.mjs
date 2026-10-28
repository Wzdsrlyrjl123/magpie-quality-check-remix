import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const root=path.resolve(import.meta.dirname,'..');
const magpie=process.env.MAGPIE_BINARY;
if(!magpie)throw Error('Set MAGPIE_BINARY to an existing Magpie executable');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'quality-magpie-'));
const children=[];
let calls=0;
const upstream=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=JSON.parse(raw);calls++;
 const answer=body.messages?.at(-1)?.content?.startsWith('A previously isolated')?'46.24 inches':'business reply';
 res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'fixture',model:'solo',choices:[{message:{role:'assistant',content:answer},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const port=upstream.address().port;
// A dedicated portable copy prevents a data/ directory beside the user's
// executable from taking precedence over this fixture's XDG paths.
const host=path.join(dir,'host');
const config=path.join(host,'data');await fs.mkdir(config,{recursive:true});
const isolatedMagpie=path.join(host,process.platform==='win32'?'magpie.exe':'magpie');
await fs.copyFile(magpie,isolatedMagpie);await fs.chmod(isolatedMagpie,0o700);
await fs.writeFile(path.join(host,'.portable'),'');
const gate=path.join(dir,'quality.middleware.js');await fs.copyFile(path.join(root,'plugin/gate.middleware.js'),gate);
await fs.writeFile(path.join(config,'providers.json'),JSON.stringify({providers:[{id:'fixture',name:'Fixture',key:'fixture',chat:`http://127.0.0.1:${port}/v1`,models:['solo','luna']}]}));
await fs.writeFile(path.join(config,'plugins.json'),JSON.stringify({plugins:[{spec:gate}]}));
const log=path.join(dir,'magpie.log');await fs.writeFile(log,'');
const gatewayPort=await new Promise(resolve=>{const s=http.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
const gateway=`http://127.0.0.1:${gatewayPort}`;
function launch(binary,args,env){const p=spawn(binary,args,{env,stdio:['pipe','pipe','pipe'],windowsHide:true});children.push(p);return p}
async function waitFor(fn){const until=Date.now()+20000;while(Date.now()<until){try{const v=await fn();if(v)return v}catch{}await new Promise(r=>setTimeout(r,150))}throw Error('integration timed out')}
try{
 const mp=launch(isolatedMagpie,['serve'],{...process.env,HOME:dir,USERPROFILE:dir,CODEX_HOME:path.join(dir,'.codex'),CLAUDE_CONFIG_DIR:path.join(dir,'.claude'),PI_CODING_AGENT_DIR:path.join(dir,'.pi','agent'),MAGPIE_NO_ACCOUNTS:'1',XDG_CONFIG_HOME:path.join(dir,'config'),XDG_CACHE_HOME:path.join(dir,'cache'),MAGPIE_ADDR:`127.0.0.1:${gatewayPort}`});
 mp.stderr.on('data',b=>fs.appendFile(log,b));mp.stdout.on('data',()=>{});
 await waitFor(async()=>{const r=await fetch(gateway+'/v1/models',{signal:AbortSignal.timeout(2000)});return r.ok&&(await r.json()).data.some(m=>m.id==='fixture/solo')});
 const qcBinary=path.join(dir,process.platform==='win32'?'quality-check.exe':'quality-check');
 await fs.copyFile(path.join(root,'bin',process.platform==='win32'?'quality-check.exe':'quality-check'),qcBinary);await fs.chmod(qcBinary,0o700);
 const qc=launch(qcBinary,['-data',path.join(dir,'data'),'-gate',gate,'-owned'],process.env);
 let output='',qcError='';qc.stderr.on('data',b=>qcError+=b);
 const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('quality backend startup timed out: '+qcError)),10000);qc.stdout.on('data',b=>{output+=b;const i=output.indexOf('\n');if(i>=0){clearTimeout(timer);resolve(JSON.parse(output.slice(0,i)))}});qc.once('error',e=>{clearTimeout(timer);reject(e)});qc.once('exit',code=>{clearTimeout(timer);reject(Error('quality backend exited '+code+': '+qcError))})});
 const info=await ready;
 const api=async(p,body)=>{const r=await fetch(info.origin+p,{method:body?'POST':'GET',headers:{authorization:'Bearer '+info.control,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error(await r.text());return r.json()};
 const configure=values=>api('/api/config',{gateway_url:gateway,gateway_key:'magpie',log_path:log,daily_limit:120,...values});
 await configure({gate_mode:'strict'});
 await api('/api/target',{model:'fixture/solo',enabled:true});
 await new Promise(r=>setTimeout(r,1500));
 const call=async (model,agent)=>fetch(gateway+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+(agent?'magpie-'+agent:'magpie'),'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'business'}],max_tokens:100}),signal:AbortSignal.timeout(5000)});
 let response=await call('fixture/solo');assert.equal(response.status,403);assert.equal(calls,0,'blocked business reached upstream');
 try{await waitFor(async()=>{const v=await api('/api/state');return v.state.targets['fixture/solo'].state==='passed'});}catch(e){console.error(JSON.stringify(await api('/api/state')));console.error(await fs.readFile(log,'utf8'));throw e}
 await new Promise(r=>setTimeout(r,1200));response=await call('fixture/solo');assert.equal(response.status,200,await response.text());
 await api('/api/action',{model:'fixture/solo',action:'hold'});await new Promise(r=>setTimeout(r,1200));response=await call('fixture/solo');assert.equal(response.status,403);
 for(const [endpoint,body] of [
  ['/v1/messages',{model:'fixture/solo',max_tokens:100,messages:[{role:'user',content:'business'}]}],
  ['/v1/responses',{model:'fixture/solo',input:'business'}],
 ]){
  const before=calls;
  const blocked=await fetch(gateway+endpoint,{method:'POST',headers:{authorization:'Bearer magpie','x-api-key':'magpie','anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(blocked.status,403,endpoint);
  const error=await blocked.json();assert.equal(error.error.type,'permission_error');assert.match(error.error.message,/MAGPIE_QUALITY_REVIEW_REQUIRED/);assert.equal(calls,before);
 }
 response=await call('fixture/luna');assert.equal(response.status,200);
 await configure({gate_mode:'strict',gate_agents:'pi'});await new Promise(r=>setTimeout(r,1200));
 response=await call('fixture/solo','pi');assert.equal(response.status,403,'selected harness should be held');
 response=await call('fixture/solo','codex');assert.equal(response.status,200,await response.text());
 await configure({gate_mode:'observe'});await new Promise(r=>setTimeout(r,1200));
 response=await call('fixture/solo','pi');assert.equal(response.status,200,'observe mode must preserve business calls during hold');
 await api('/api/target',{model:'fixture/luna',enabled:true});await new Promise(r=>setTimeout(r,1200));
 response=await call('fixture/luna','codex');assert.equal(response.status,200,'unverified observe target must pass immediately');
 await waitFor(async()=>{const v=await api('/api/state');return v.state.targets['fixture/luna'].state==='passed'});
 console.log('PASS: real Magpie probes through alias, strict gate blocks before upstream, scopes by harness, and observe mode leaves business requests available during hold');
}finally{
 for(const p of children){p.stdin.end();p.kill('SIGTERM')}
 await Promise.all(children.map(async p=>{if(p.exitCode===null)await Promise.race([once(p,'exit'),new Promise(r=>setTimeout(r,3000))]);if(p.exitCode===null)p.kill('SIGKILL')}));
 upstream.close();await fs.rm(dir,{recursive:true,force:true});
}
