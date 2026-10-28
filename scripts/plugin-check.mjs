import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import http from 'node:http';
const root=process.env.PLUGIN_ROOT||path.resolve(import.meta.dirname,'..');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'quality-plugin-'));
await fs.cp(path.join(root,'plugin'),path.join(dir,'plugin'),{recursive:true});
const gatewayServer=http.createServer((req,res)=>{
 assert.equal(req.url,'/v1/models');assert.equal(req.headers.authorization,'Bearer magpie');
 res.setHeader('content-type','application/json');res.end('{"data":[]}');
});
const gatewayPort=await new Promise(resolve=>{const reservation=http.createServer();reservation.listen(0,'127.0.0.1',()=>{const port=reservation.address().port;reservation.close(()=>resolve(port));})});
const gateway=`http://127.0.0.1:${gatewayPort}`;
const binaryPath=path.join(root,'bin',process.platform==='win32'?'quality-check.exe':'quality-check');
const script=`import plugin from ${JSON.stringify('file://'+path.join(dir,'plugin/index.mjs'))};const hooks=await plugin.server({},${JSON.stringify({binaryPath,dataDir:path.join(dir,'data'),gatewayURL:gateway})});await hooks.config({});const first=await hooks.auth.methods[0].authorize();const second=await hooks.auth.methods[0].authorize();console.log(JSON.stringify({first:first.url,second:second.url}));setInterval(()=>{},1000);`;
const p=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});let raw='';let error='';p.stderr.on('data',b=>error+=b);
try{
 const v=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('plugin startup timeout '+error)),15000);p.stdout.on('data',b=>{raw+=b;const i=raw.indexOf('\n');if(i>=0){clearTimeout(timer);resolve(JSON.parse(raw.slice(0,i)))}});p.once('exit',()=>{clearTimeout(timer);reject(Error(error))})});
 assert.notEqual(v.first,v.second);const r=await fetch(v.first,{redirect:'manual'});assert.equal(r.status,303);const repeat=await fetch(v.first,{redirect:'manual'});assert.equal(repeat.status,401);
 await new Promise(resolve=>gatewayServer.listen(gatewayPort,'127.0.0.1',resolve));
 const cookie=r.headers.get('set-cookie').split(';')[0];
 const deadline=Date.now()+12000;
 let state;
 while(Date.now()<deadline){
  state=await (await fetch(new URL('/api/state',v.first),{headers:{cookie}})).json();
  if(state.gateway_configured)break;
  await new Promise(resolve=>setTimeout(resolve,150));
 }
 assert.equal(state.gateway_configured,true,'delayed gateway not discovered');
 assert.equal(state.state.config.gateway_url,gateway);
 assert.equal(state.state.config.gateway_key,'');
 p.kill('SIGKILL');await new Promise(r=>p.once('exit',r));
 await new Promise(r=>setTimeout(r,1000));let closed=false;try{await fetch(v.second)}catch{closed=true}assert.ok(closed,'Go service survived host exit');
 console.log('PASS: plugin starts before gateway, background discovery configures delayed gateway, new tickets, host death stops Go service');
}finally{if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');await new Promise(resolve=>gatewayServer.close(resolve));await fs.rm(dir,{recursive:true,force:true})}
