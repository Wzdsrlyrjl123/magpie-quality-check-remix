import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
const root=process.env.PLUGIN_ROOT||path.resolve(import.meta.dirname,'..');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'quality-plugin-'));
await fs.cp(path.join(root,'plugin'),path.join(dir,'plugin'),{recursive:true});
await fs.copyFile(path.join(root,'package.json'),path.join(dir,'package.json'));
const gatewayServer=http.createServer((req,res)=>{
 assert.equal(req.url,'/v1/models');assert.equal(req.headers.authorization,'Bearer magpie');
 res.setHeader('content-type','application/json');res.end('{"data":[]}');
});
const gatewayPort=await new Promise(resolve=>{const reservation=http.createServer();reservation.listen(0,'127.0.0.1',()=>{const port=reservation.address().port;reservation.close(()=>resolve(port));})});
const gateway=`http://127.0.0.1:${gatewayPort}`;
const binaryPath=path.join(root,'bin',process.platform==='win32'?'quality-check.exe':'quality-check');
const script=`import plugin from ${JSON.stringify(pathToFileURL(path.join(dir,'plugin/index.mjs')).href)};const hooks=await plugin.server({},${JSON.stringify({binaryPath,dataDir:path.join(dir,'data'),gatewayURL:gateway})});await hooks.config({});console.log('ready');process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
const p=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});let raw='';let error='';p.stderr.on('data',b=>error+=b);
try{
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('plugin startup timeout '+error)),15000);p.stdout.on('data',b=>{raw+=b;if(raw.includes('ready')){clearTimeout(timer);resolve()}});p.once('exit',()=>{clearTimeout(timer);reject(Error(error))})});
 const window = {};
 vm.runInNewContext(await fs.readFile(path.join(dir,'plugin/sidebar-session.js'),'utf8'), { window });
 const { origin, token } = window.qualityCheckSidebar;
 const sidebar = `${origin}/sidebar/${token}/`;
 assert.equal((await fetch(sidebar)).status, 200);
 assert.equal((await fetch(`${origin}/api/state`, { headers: { origin: 'null' } })).status, 401);
 await new Promise(resolve=>gatewayServer.listen(gatewayPort,'127.0.0.1',resolve));
 const deadline=Date.now()+12000;
 let state;
 while(Date.now()<deadline){
  state=await (await fetch(new URL('api/state',sidebar),{headers:{origin:'null'}})).json();
  if(state.gateway_configured)break;
  await new Promise(resolve=>setTimeout(resolve,150));
 }
 assert.equal(state.gateway_configured,true,'delayed gateway not discovered');
 assert.equal(state.state.config.gateway_url,gateway);
 assert.equal(state.state.config.gateway_key,'');
 p.kill('SIGTERM');await new Promise(r=>p.once('exit',r));
 const stopDeadline=Date.now()+6000;let closed=false;while(Date.now()<stopDeadline&&!closed){try{await fetch(`${origin}/health`)}catch{closed=true}if(!closed)await new Promise(r=>setTimeout(r,150))}assert.ok(closed,'Go service survived host exit');
 console.log('PASS: sidebar session, delayed gateway discovery and backend shutdown');
}finally{if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');await new Promise(resolve=>gatewayServer.close(resolve));await fs.rm(dir,{recursive:true,force:true})}
