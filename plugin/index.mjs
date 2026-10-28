import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { resolveCloudflared } from './cloudflared-runtime.mjs';
import { startGatewayDiscovery } from './gateway-discovery.mjs';
import { waitForConsole } from './console-readiness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let child, ready, stopDiscovery;
function start(options = {}) {
  if (ready) return ready;

  let startup;
  startup = (async () => {
    const platform = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform] || process.platform;
    const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch] || process.arch;
    const suffix = platform === 'windows' ? '.exe' : '';
    const bundled = path.join(root, 'bin', `quality-check-${platform}-${arch}${suffix}`);
    const fallback = path.join(root, 'bin', `quality-check${suffix}`);
    const dataDir = path.resolve(options.dataDir || path.join(os.homedir(), '.config', 'magpie-quality-check'));
    let binary = options.binaryPath || (requireFile(bundled) ? bundled : fallback);

    // Magpie can install plugins under a restricted directory. Launching an
    // executable there may give it an integrity label that prevents it from
    // writing its data files. A per-user runtime copy inherits the data
    // directory's permissions instead.
    if (platform === 'windows') binary = await stageWindowsBinary(binary, dataDir);

    const args = ['-data', dataDir, '-gate', path.join(root, 'plugin', 'gate.middleware.js'), '-owned'];
    if (options.cloudflaredPath) args.push('-cloudflared', options.cloudflaredPath);

    return await new Promise((resolve, reject) => {
      const process = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child = process;
      process.stdin.on('error', () => {});
      let output = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => fail(new Error(formatStartupFailure('启动超时', stderr))), 15000);

      function cleanup() {
        clearTimeout(timer);
        if (child === process) {
          child = undefined;
          stopDiscovery?.();
          stopDiscovery = undefined;
          if (ready === startup) ready = undefined;
        }
      }
      function fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
        process.kill();
      }

      process.stdout.on('data', bytes => {
        output += bytes;
        const newline = output.indexOf('\n');
        if (newline < 0) return;
        try {
          const value = JSON.parse(output.slice(0, newline));
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        } catch {
          fail(new Error(formatStartupFailure('后台启动信息无效', stderr)));
        }
      });
      process.stderr.on('data', bytes => {
        stderr = (stderr + bytes.toString()).slice(-4000);
      });
      process.once('error', error => {
        cleanup();
        if (!settled) {
          settled = true;
          reject(new Error(formatStartupFailure(`无法启动后台进程：${error.message}`, stderr)));
        }
      });
      process.once('exit', (code, signal) => {
        cleanup();
        if (!settled) {
          settled = true;
          const reason = code === null ? `进程被终止（${signal || '未知信号'}）` : `进程退出，代码 ${code}`;
          reject(new Error(formatStartupFailure(reason, stderr)));
        }
      });
    });
  })();

  ready = startup;
  startup.catch(() => { if (ready === startup) ready = undefined; });
  return startup;
}

function formatStartupFailure(reason, stderr) {
  const detail = stderr.trim();
  return `检测后台${reason}${detail ? `：${detail}` : ''}`;
}

async function stageWindowsBinary(binary, dataDir) {
  const source = await readFile(binary);
  const digest = createHash('sha256').update(source).digest('hex');
  const runtimeDir = path.join(dataDir, 'runtime');
  const destination = path.join(runtimeDir, `quality-check-${digest}.exe`);
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });

  try {
    const cached = await readFile(destination);
    if (createHash('sha256').update(cached).digest('hex') === digest) return destination;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyFile(binary, temporary);
    try {
      await rename(temporary, destination);
    } catch (error) {
      // Another plugin host may have published the same immutable binary.
      const cached = await readFile(destination).catch(() => undefined);
      if (!cached || createHash('sha256').update(cached).digest('hex') !== digest) throw error;
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return destination;
}

function requireFile(file) {
  return existsSync(file);
}
process.once('exit', () => child?.kill());
export default { id: 'quality-check', server: async (_input, options = {}) => ({
  auth: {
    provider: 'quality-check',
    methods: [false,true].map(remote=>({ type: 'oauth', label: remote?'打开临时远程控制台（Cloudflare）':'打开本机质量检测控制台', async authorize() {
      const v = await start(options);
      const binary=remote?await resolveCloudflared(options,options.dataDir || path.join(os.homedir(), '.config', 'magpie-quality-check')):undefined;
      const r=await fetch(v.origin+'/api/console',{method:'POST',headers:{authorization:'Bearer '+v.control,'content-type':'application/json'},body:JSON.stringify({remote,binary})});
      if(!r.ok)throw Error(await r.text());const {url}=await r.json();
      if(remote){
        try { await waitForConsole(url); }
        catch(error){
          await fetch(v.origin+'/api/console/close',{method:'POST',headers:{authorization:'Bearer '+v.control,'content-type':'application/json'},body:'{}'}).catch(()=>{});
          // The service delays tunnel shutdown to deliver its acknowledgement.
          await new Promise(resolve=>setTimeout(resolve,350));
          throw error;
        }
      }
      return { url, instructions: `完整管理链接：${url}\n复制链接后在浏览器打开。链接十分钟内有效且只能使用一次。此入口不是供应商登录，无需提交验证码；使用后可以取消此窗口。${remote ? '临时通道最长 30 分钟。' : ''}`, method: 'code', callback: async () => ({ type: 'failed' }) };
    } })),
    async loader() { await start(options); return {}; }
  },
  async config(cfg) {
    // The control-only provider has no inference calls to trigger loader.
    // Start on host configuration so persisted monitoring works after restart.
    await start(options);
    const service=await ready;
    stopDiscovery ??= startGatewayDiscovery(service, options);
    cfg.provider ??= {};
    cfg.provider['quality-check'] = { name: 'Intelligence Check', models: {} };
  }
}) };
