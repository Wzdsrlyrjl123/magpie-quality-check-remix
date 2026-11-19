import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const page = await readFile(path.join(root, 'plugin/page.js'), 'utf8');
const html = await readFile(path.join(root, 'plugin/page.html'), 'utf8');

async function runPage(magpie, origin = 'https://magpie.example') {
  const replacements = [];
  const context = vm.createContext({
    window: { magpie, qualityCheckSidebar: { origin: 'http://127.0.0.1:43489', token: 'fixture' } },
    URL,
    location: {
      href: `${origin}/_magpie/plugin/token/page.html?_o=${encodeURIComponent(origin)}`,
      replace: value => replacements.push(value),
    },
    document: {
      body: { textContent: '' },
      createElement: () => ({ remove() {} }),
      head: { appendChild: script => script.onload() },
    },
  });
  vm.runInContext(page, context);
  await new Promise(resolve => setImmediate(resolve));
  return { replacements, message: context.document.body.textContent };
}

test('loads the bridge before page code', () => {
  assert.ok(html.indexOf('src="_magpie/bridge.js"') < html.indexOf('src="./page.js"'));
});

test('uses the current Magpie host for the proxied server service', async () => {
  const result = await runPage({ ready: Promise.resolve(), service: 'http://100.127.147.101:43489/_magpie/plugin/token/_magpie/service/' });
  assert.deepEqual(result.replacements, ['https://magpie.example/_magpie/plugin/token/_magpie/service/sidebar/fixture/']);
  assert.equal(result.message, '');
});

test('uses the local service in desktop mode', async () => {
  const result = await runPage({ ready: Promise.resolve(), service: '' }, 'http://127.0.0.1:1668');
  assert.deepEqual(result.replacements, ['http://127.0.0.1:43489/sidebar/fixture/']);
});

test('does not navigate to a loopback service from a remote page with no proxy', async () => {
  const result = await runPage({ ready: Promise.resolve(), service: '' });
  assert.deepEqual(result.replacements, []);
  assert.match(result.message, /未提供插件服务代理/);
});
