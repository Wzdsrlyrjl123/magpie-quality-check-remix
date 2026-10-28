import { mkdir, opendir, stat, unlink, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const clean = v => typeof v === 'string' && v.trim() && [...v.trim()].length <= 200 ? v.trim() : '';
export function observation() {
  const models = [], seen = new Set();
  let first = '', final = '', conflict = false;
  return {
    observe(chunk) {
      try {
      const model = clean(chunk?.model);
      if (!model) return;
      if (!first) first = model;
      const terminal = Array.isArray(chunk?.choices) && chunk.choices.some(c => c?.finish_reason != null);
      if (terminal) final = model;
      if (!seen.has(model)) {
        if (seen.size) conflict = true;
        if (models.length < 16) { seen.add(model); models.push(model); }
        else if (terminal) { seen.delete(models.pop()); seen.add(model); models.push(model); }
      }
      } catch {} // An observer must never interfere with the provider stream.
    },
    receipt(id) {
      // A final value beyond the bounded list cannot be represented safely.
      const response = final && seen.has(final) ? final : first;
      return {schema:1,response_id:id,provider:'qoder',sent_model:'',response_model:response,models,conflict,source:'qoder.raw_sse.body.model',captured_at:new Date().toISOString()};
    }
  };
}

// Receipt failures never alter inference. The deadline bounds the latency paid
// by the response; pruning limits stale metadata without retaining prompts.
export async function saveObservation(id, obs, dataDir) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) return;
  const dir = path.join(path.resolve(dataDir || path.join(os.homedir(), '.config', 'magpie-quality-check')), 'upstream-observations');
  const work = (async () => {
    await mkdir(dir, {recursive:true,mode:0o700});
    const tmp = path.join(dir, `.${id}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify(obs.receipt(id)), {flag:'wx',mode:0o600});
      await rename(tmp,path.join(dir,id+'.json'));
    } finally { await unlink(tmp).catch(()=>{}); }
    const entries = [];
    const d = await opendir(dir);
    let scanned = 0;
    for await (const e of d) {
      if (++scanned > 1024) break;
      if (!e.isFile() || !/^[A-Za-z0-9_-]{1,160}\.json$/.test(e.name)) continue;
      const file = path.join(dir,e.name);
      const s = await stat(file).catch(()=>null);
      if (s) entries.push({file,mtime:s.mtimeMs});
    }
    entries.sort((a,b)=>b.mtime-a.mtime);
    const now=Date.now();
    await Promise.all(entries.filter((e,i)=>e.file !== path.join(dir,id+'.json') && (i>=512 || now-e.mtime>10*60*1000)).map(e=>unlink(e.file).catch(()=>{})));
  })().catch(()=>{});
  await Promise.race([work,new Promise(resolve=>setTimeout(resolve,200))]);
}
