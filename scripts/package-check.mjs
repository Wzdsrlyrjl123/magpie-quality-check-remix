import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import adapterPlugin from '../adapters/qoder/index.mjs';
const root=path.resolve(import.meta.dirname,'..');
const hooks=await adapterPlugin.server({client:{}});assert.equal(hooks.provider.id,'qoder');assert.equal(hooks.auth.provider,'qoder');
const manifest=JSON.parse(await fs.readFile(path.join(root,'dist/manifest.json'),'utf8'));
for(const item of manifest.artifacts){
 const bytes=await fs.readFile(path.join(root,'dist',item.name));assert.equal(bytes.length,item.size);assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256,item.name);
 if(item.name.endsWith('.tgz')){
  const listing=spawnSync('tar',['-tzf',path.join(root,'dist',item.name)],{encoding:'utf8'});assert.equal(listing.status,0);
  for(const name of ['package.json','assets/icon.png','assets/plugin-icon.png','plugin/index.mjs','plugin/gate.middleware.js','plugin/cloudflared-runtime.mjs','third_party/cloudflared/LICENSE','adapters/qoder/package.json','adapters/qoder/index.mjs','adapters/qoder/observation.mjs','adapters/qoder/vendor.mjs','third_party/qoder/LICENSE','third_party/qoder/LICENSE-CLIProxyAPI','third_party/qoder/NOTICE.md','README.md'])assert.ok(listing.stdout.includes('/'+name),`${item.name} missing ${name}`);
  const metadata=spawnSync('tar',['-xOzf',path.join(root,'dist',item.name),item.name.slice(0,-4)+'/package.json'],{encoding:'utf8'});assert.equal(metadata.status,0);
  const pkg=JSON.parse(metadata.stdout);assert.equal(pkg.magpie.icon,'data:image/png;base64,'+(await fs.readFile(path.join(root,'assets/plugin-icon.png'))).toString('base64'));assert.ok(Buffer.byteLength(pkg.magpie.icon)<1024*1024);
  const prefix=item.name.slice(0,-4);
  const adapter=spawnSync('tar',['-xOzf',path.join(root,'dist',item.name),prefix+'/adapters/qoder/package.json'],{encoding:'utf8'});assert.equal(adapter.status,0);assert.equal(JSON.parse(adapter.stdout).main,'./index.mjs');
  for(const file of ['adapters/qoder/index.mjs','adapters/qoder/observation.mjs','adapters/qoder/vendor.mjs']){
   const entry=spawnSync('tar',['-xOzf',path.join(root,'dist',item.name),prefix+'/'+file],{encoding:'utf8',maxBuffer:8*1024*1024});assert.equal(entry.status,0);assert.equal(entry.stdout,await fs.readFile(path.join(root,file),'utf8'),file);
  }
  const gate=spawnSync('tar',['-xOzf',path.join(root,'dist',item.name),prefix+'/plugin/gate.middleware.js'],{encoding:'utf8'});assert.equal(gate.stdout,'export function onRequest(body) { return body; }\n');
 }
}
console.log(`PASS: ${manifest.artifacts.length} checksummed artifacts, complete plugin archives, no runtime gate credentials`);
