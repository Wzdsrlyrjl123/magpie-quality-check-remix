import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export async function discoverGateway(options = {}, env = process.env, fetcher = fetch) {
  let url = options.gatewayURL;
  const key = options.gatewayKey || 'magpie';
  if (!url) {
    let port = 3425;
    try {
      const settings = JSON.parse(await fs.readFile(path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'magpie', 'settings.json'), 'utf8'));
      if (Number.isInteger(settings.port) && settings.port > 0 && settings.port < 65536) port = settings.port;
    } catch {}
    let address = env.MAGPIE_ADDR || `127.0.0.1:${port}`;
    if (/^0\.0\.0\.0:\d+$/.test(address)) address = address.replace('0.0.0.0', '127.0.0.1');
    if (/^\[::\]:\d+$/.test(address)) address = address.replace('[::]', '[::1]');
    if (/^:\d+$/.test(address)) address = '127.0.0.1' + address;
    // Discovery never sends the default key to a non-loopback host.
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(address)) return undefined;
    url = `http://${address}`;
  }
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed['pass' + 'word'] || parsed.search || parsed.hash) return undefined;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && !options.gatewayKey) return undefined;
    const base = url.replace(/\/$/, '');
    const response = await fetcher(base + (base.endsWith('/v1') ? '' : '/v1') + '/models', {
      headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return undefined;
    const data = await response.json();
    if (!Array.isArray(data.data)) return undefined;
    const config = { gateway_url: url, gateway_key: key, log_path: options.logPath || '', daily_limit: 120 };
    config.gate_mode = options.gateMode || 'observe';
    config.gate_agents = options.gateAgents || '';
    // Only a validated level is forwarded; anything else stays unset so the
    // gateway keeps its own default.
    if (typeof options.effort === 'string' && options.effort.trim()) config.effort = options.effort.trim().toLowerCase();
    return config;
  } catch { return undefined; }
}

// Discovery must not hold up Magpie's config hook: the gateway may need that
// hook to finish before /v1/models can respond.
export function startGatewayDiscovery(service, options = {}, dependencies = {}) {
  const fetcher = dependencies.fetch || fetch;
  const discover = dependencies.discover || discoverGateway;
  const interval = dependencies.interval ?? 5000;
  let stopped = false, timer;
  const headers = { authorization: `Bearer ${service.control}`, 'content-type': 'application/json' };
  async function attempt() {
    try {
      const response = await fetcher(service.origin + '/api/state', { headers, signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw Error('state unavailable');
      const state = await response.json();
      if (state.state.config.gateway_url) return;
      const cfg = await discover(options);
      if (cfg && !stopped) {
        const saved = await fetcher(service.origin + '/api/config/initial', {
          method: 'POST', headers, body: JSON.stringify(cfg), signal: AbortSignal.timeout(3000),
        });
        if (saved.ok) return;
      }
    } catch {}
    if (!stopped) {
      timer = setTimeout(attempt, interval);
      timer.unref?.();
    }
  }
  timer = setTimeout(attempt, 0);
  timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}
