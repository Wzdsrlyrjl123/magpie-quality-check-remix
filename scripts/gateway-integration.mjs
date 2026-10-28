import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const binary = process.env.MAGPIE_BINARY;
if (!binary) throw Error('Set MAGPIE_BINARY to an existing Magpie executable');
const root = path.resolve(import.meta.dirname, '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-discovery-magpie-'));
const installed = path.join(dir, 'plugin');
const data = path.join(dir, 'data');
const config = path.join(dir, 'config', 'magpie');
const port = await new Promise(resolve => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
let child, database, output = '';
try {
  await fs.mkdir(installed, { recursive: true });
  for (const entry of ['package.json', 'plugin', 'assets']) {
    await fs.cp(path.join(root, entry), path.join(installed, entry), { recursive: true });
  }
  await fs.mkdir(config, { recursive: true });
  await fs.writeFile(path.join(config, 'providers.json'), JSON.stringify({ providers: [] }));
  await fs.writeFile(path.join(config, 'plugins.json'), JSON.stringify({
    plugins: [{
      spec: installed,
      options: { dataDir: data, binaryPath: path.join(root, 'bin', 'quality-check') },
    }],
  }));
  child = spawn(binary, ['web', '--addr', '127.0.0.1:0', '--no-open', '--gateway'], {
    env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_CACHE_HOME: path.join(dir, 'cache'), MAGPIE_ADDR: `0.0.0.0:${port}`, MAGPIE_WEB_KEY: 'quality-fixture-key' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  const webDeadline = Date.now() + 30000;
  let link;
  while (Date.now() < webDeadline) {
    link = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?k=quality-fixture-key/)?.[0];
    if (link) break;
    if (child.exitCode !== null) throw Error('Magpie web failed to start: ' + output.slice(-1500));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(link, 'Magpie web did not issue a management link');
  const exchange = await fetch(link, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  assert.equal(exchange.status, 303);
  const cookie = exchange.headers.get('set-cookie').split(';')[0];
  const plugins = await fetch(new URL('/api/plugins', link), {
    headers: { cookie }, signal: AbortSignal.timeout(60000),
  });
  assert.equal(plugins.status, 200);
  assert.match(await plugins.text(), /二创版/);
  const signin = await fetch(new URL('/api/plugin-signin', link), {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: new URL(link).origin },
    body: JSON.stringify({ provider: 'quality-check', method: 0 }), signal: AbortSignal.timeout(10000),
  });
  assert.equal(signin.status, 200);
  const flow = await signin.json();
  assert.ok(flow.url?.includes('/open/'), 'full management link missing');
  assert.equal(flow.pasteCode, true, 'management flow auto-completed');
  await new Promise(resolve => setTimeout(resolve, 1000));
  const status = await fetch(new URL('/api/signin/' + flow.id, link), { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal((await status.json()).state, 'waiting', 'management link collapsed into provider login');
  let state;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error(`Magpie exited with code ${child.exitCode}`);
    try {
      if (!database) database = new DatabaseSync(path.join(data, 'check.db'), { readOnly: true });
      const row = database.prepare('SELECT body FROM state WHERE id=1').get();
      if (row) state = JSON.parse(Buffer.from(row.body).toString());
      if (state?.config.gateway_url) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(state?.config.gateway_url, 'real Magpie did not discover its gateway; plugin startup output: ' + output.slice(-1500));
  assert.equal(state.config.gateway_url, `http://127.0.0.1:${port}`);
  assert.equal(state.config.gateway_key, 'magpie');
  const response = await fetch(state.config.gateway_url + '/v1/models', {
    headers: { authorization: 'Bearer ' + state.config.gateway_key },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray((await response.json()).data));
  console.log('PASS: real Magpie loads full plugin and automatically verifies and saves a wildcard gateway with no manual configuration');
} finally {
  database?.close();
  if (child && child.exitCode === null) {
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exit;
    clearTimeout(timeout);
  }
  await fs.rm(dir, { recursive: true, force: true });
}
