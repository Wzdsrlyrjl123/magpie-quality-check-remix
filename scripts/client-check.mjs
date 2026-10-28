import http from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'quality-clients-'));
await fs.mkdir(path.join(dir,'codex'),{recursive:true});await fs.mkdir(path.join(dir,'claude'),{recursive:true});
const marker='[MAGPIE_QUALITY_REVIEW_REQUIRED] 当前模型已暂停，需要人工检查渠道状态。';
let calls=0;
const server=http.createServer(async(req,res)=>{
 for await(const _ of req){}calls++;
 res.writeHead(403,{'content-type':'application/json'});
 res.end(JSON.stringify({type:'error',error:{type:'permission_error',message:marker}}));
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
async function run(binary,args,env){
 const p=spawn(binary,args,{cwd:dir,env:{...process.env,HOME:dir,USERPROFILE:dir,...env},stdio:['ignore','pipe','pipe'],windowsHide:true});let out='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>out+=b);
 const timer=setTimeout(()=>p.kill('SIGKILL'),45000);
 try{return await new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',(code,signal)=>resolve({code,signal,out}))});}finally{clearTimeout(timer);}
}
try{
 const before=calls;
 const codex=await run(process.env.CODEX_BINARY||'codex',['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--json','-m','fixture/solo','-c','model_provider="quality_fixture"','-c','model_providers.quality_fixture.name="Quality fixture"','-c',`model_providers.quality_fixture.base_url="${base}/v1"`,'-c','model_providers.quality_fixture.wire_api="responses"','-c','model_providers.quality_fixture.env_key="QUALITY_FIXTURE_KEY"','-c','model_providers.quality_fixture.request_max_retries=0','Reply hello'],{CODEX_HOME:path.join(dir,'codex'),QUALITY_FIXTURE_KEY:'fixture'});
 assert.ok(calls>before,'Codex did not call fixture: '+codex.out);assert.match(codex.out,/MAGPIE_QUALITY_REVIEW_REQUIRED/);assert.notEqual(codex.code,0);console.log('PASS: Codex displays quality gate API error and exits unsuccessfully');
 const prior=calls;
 const claude=await run(process.env.CLAUDE_BINARY||'claude',['--bare','-p','--model','fixture/solo','--tools','','--setting-sources','','Reply hello'],{ANTHROPIC_BASE_URL:base,ANTHROPIC_API_KEY:'fixture',CLAUDE_CONFIG_DIR:path.join(dir,'claude'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'});
 assert.ok(calls>prior,'Claude did not call fixture');assert.match(claude.out,/MAGPIE_QUALITY_REVIEW_REQUIRED/);assert.notEqual(claude.code,0);console.log('PASS: Claude Code displays quality gate API error and exits unsuccessfully');
}finally{await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
