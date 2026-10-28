import { $, text, icon, hydrateIcons, syncSelect, dateTime, names } from './ui.js';
import { renderModelTrace, runModelTrace } from '../modeltrace/panel.js';
import { analyzeAnswer } from './answer-analysis.js';
import { renderSVGPreview } from './svg-preview.js';
import { renderHTMLPreview, stopHTMLPreview } from './html-preview.js';

let data, polling = false, stopped = false, pollError = '', targetSignature, historySignature, historyLimit = 30, routeSignature;
const config = $('#config');
const secretType = 'pass' + 'word';
config.elements.gateway_key.type = secretType;
config.elements.gateway_key.autocomplete = 'new-' + secretType;
let configDirty = false;
let awaitingTest;
const testErrors = new Map();
let shownRecord, reviewDirty = false, analysisSignature;
hydrateIcons();

function feedback(value, success = false) {
  $('#message').textContent = value;
  $('#message').className = 'feedback' + (success ? ' success' : '');
}
async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const raw = await response.text();
    if (response.status === 401) throw Error('管理会话已失效，请从 Magpie 插件重新打开控制台。');
    if (/<!doctype|<html/i.test(raw)) throw Error(`控制台连接暂时不可用（HTTP ${response.status}），请稍后重试；持续失败请从插件重新打开远程入口。`);
    throw Error(raw.trim() || `请求失败（HTTP ${response.status}）`);
  }
  return response.json();
}
async function pending(button, work, output = $('#message')) {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try { await work(); }
  catch (error) { output.textContent = error.message; output.classList.remove('success'); output.classList.add('error'); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); renderControls(); }
}
function selectView(name, focus = false) {
  if (name !== 'tests') stopHTMLPreview();
  document.querySelectorAll('[role=tab]').forEach(tab => {
    const active = tab.dataset.view === name;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(`#view-${tab.dataset.view}`).hidden = !active;
    if (active && focus) tab.focus();
  });
}
const tabs = [...document.querySelectorAll('[role=tab]')];
tabs.forEach((tab, i) => {
  tab.onclick = () => selectView(tab.dataset.view);
  tab.onkeydown = event => {
    const index = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (index !== undefined) { event.preventDefault(); selectView(tabs[index].dataset.view, true); }
  };
});
function theme(mode) {
  document.documentElement.dataset.theme = mode;
  const label = mode === 'dark' ? '切换为亮色' : '切换为暗色';
  $('#theme').setAttribute('aria-label', label);
  $('#theme').dataset.tooltip = label;
  $('#theme').replaceChildren(icon(mode === 'dark' ? 'Sun' : 'Moon'));
}
try { theme(localStorage.getItem('theme') === 'light' ? 'light' : 'dark'); } catch { theme('dark'); }
$('#theme').onclick = () => {
  const mode = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  theme(mode);
  try { localStorage.setItem('theme', mode); } catch {}
};
function openSettings() {
  if (!$('#settingsDialog').open) $('#settingsDialog').showModal();
}
$('#settings').onclick = openSettings;
$('#connectSettings').onclick = openSettings;
$('#closeSettings').onclick = () => $('#settingsDialog').close();
$('#settingsDialog').onclick = event => { if (event.target === $('#settingsDialog')) {
  const rect = event.target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
} };
config.oninput = () => { configDirty = true; };
$('#showKey').onclick = () => {
  const show = config.elements.gateway_key.type === secretType;
  config.elements.gateway_key.type = show ? 'text' : secretType;
  $('#showKey').replaceChildren(icon(show ? 'EyeOff' : 'Eye'));
  $('#showKey').setAttribute('aria-label', show ? '隐藏输入的 Key' : '显示输入的 Key');
  $('#showKey').dataset.tooltip = $('#showKey').getAttribute('aria-label');
};
function requireGateway() {
  if (data?.gateway_configured) return true;
  openSettings();
  $('#configMessage').textContent = '请保存 Magpie 网关 URL 和 Key；本机默认 Key 为 magpie。';
  config.elements.gateway_url.focus();
  return false;
}
function modelRunning(model) { return data?.state.results?.some(r => r.model === model && r.verdict === 'running'); }

// Reasoning effort. The gateway publishes supported levels per model; an empty
// selection means "let Magpie decide" and sends no reasoning_effort field.
const EFFORT_LABELS = { low: '低 low', medium: '中 medium', high: '高 high', xhigh: '很高 xhigh', max: '最大 max', ultra: '极限 ultra' };
const effortLabel = level => EFFORT_LABELS[level] || level;
const knownLevels = () => data?.effort_levels || ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
function targetOf(model) { return data?.state.targets?.[model]; }
function levelsFor(model) {
  const levels = targetOf(model)?.levels;
  return levels && levels.length ? levels : knownLevels();
}
function effortFor(model) {
  const target = targetOf(model);
  return target?.effort || data?.state.config.effort || '';
}
function effortReason(model) {
  const target = targetOf(model);
  if (!target) return '';
  const levels = target.levels || [];
  const chosen = effortFor(model);
  if (target.reasoning === false) return '该模型在网关中没有思考能力标记，发送强度可能被忽略。';
  if (!levels.length) return '网关未公布该模型的思考档位；请用“读取模型能力”同步。';
  if (chosen && !levels.includes(chosen)) return `当前强度 ${effortLabel(chosen)} 不在该模型支持的 ${levels.map(effortLabel).join(' / ')} 中，Magpie 会回落到最接近的档位。`;
  return `该模型支持：${levels.map(effortLabel).join(' / ')}。`;
}
// Keep inheritance distinct from an explicit override of the same level.
function fillEffort(select, model, extraInherit) {
  const levels = levelsFor(model);
  const options = [['', extraInherit || '跟随默认设置'], ...levels.map(level => [level, effortLabel(level)])];
  const current = targetOf(model)?.effort || '';
  if (current && !levels.includes(current)) options.push([current, `${effortLabel(current)}（模型不支持）`]);
  syncSelect(select, options);
  select.value = current;
}
function renderEffort() {
  const model = $('#model').value;
  fillEffort($('#effort'), model, '跟随默认设置');
  $('#effortState').textContent = model ? effortReason(model) : '';
  $('#effortState').className = 'inline-state';
  const traceModel = $('#traceModel').value;
  fillEffort($('#traceEffort'), traceModel, '跟随默认设置');
  $('#traceEffortState').textContent = traceModel ? effortReason(traceModel) : '';
  $('#traceEffortState').className = 'inline-state';
}
// persistEffort stores the level for one model and re-renders from the server.
async function persistEffort(model, effort, select) {
  if (!model) return;
  select.disabled = true;
  try {
    await request('/api/effort', { model, effort });
    feedback(`${model}：思考强度已设为 ${effort ? effortLabel(effort) : '跟随默认设置'}`, true);
    await refresh();
  } catch (error) { feedback(error.message); }
  finally { select.disabled = false; renderControls(); }
}
function renderControls() {
  if (!data) return;
  $('#run').disabled = $('#run').hasAttribute('aria-busy') || !$('#model').value || modelRunning($('#model').value);
  $('#routeRun').disabled = $('#routeRun').hasAttribute('aria-busy') || !$('#routeModel').value.trim() || routeRunning($('#routeModel').value.trim());
  renderTestAnswer();
  renderModelTrace(data);
  // renderModelTrace fills the trace model list, so effort reads it afterwards.
  renderEffort();
  renderRoutes();
}
const routeRunning = model => (data?.route_running || []).includes(model);
const fmtMS = ms => (!ms && ms !== 0) ? '—' : ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : ms + ' ms';
function renderRoutes() {
  if (!data) return;
  const records = [...(data.state.routes || [])].reverse();
  $('#usagePathLabel').textContent = data.usage_path || '';
  const running = data.route_running || [];
  const signature = JSON.stringify([records, running]);
  if (signature === routeSignature) return;
  routeSignature = signature;
  syncSelect($('#routeEffort'), [['', '跟随默认设置'], ...knownLevels().map(level => [level, effortLabel(level)])]);
  const rows = records.map(record => {
    const row = document.createElement('tr');
    const target = text('td', '', 'model-id');
    target.dataset.label = '请求的模型';
    target.append(text('div', record.model));
    target.append(text('span', dateTime(record.time) + (record.effort ? ' / ' + effortLabel(record.effort) : '') + (record.direct ? ' / 直连（门禁未生效）' : ''), 'cell-meta'));
    const actual = record.served || record.body_model || '';
    const served = text('td', '');
    served.dataset.label = '实际交付';
    if (actual) {
      const same = actual === record.model;
      served.append(text('div', actual, 'route-actual ' + (same ? 'match' : 'diff')));
      served.append(text('span', same ? '与请求一致' : '与请求不同', 'cell-meta'));
    } else {
      served.append(text('span', record.error || '未取得回执', 'route-actual unknown'));
    }
    const provider = text('td', record.provider || '—', '');
    provider.dataset.label = '渠道';
    const cost = text('td', fmtMS(record.ms), 'numeric');
    cost.dataset.label = '耗时';
    const tokens = text('td', record.tokens ? record.tokens + ' tokens' : '—', 'numeric');
    tokens.dataset.label = '用量';
    const claim = text('td', record.self_claim || (record.error ? record.error : '—'), 'cell-claim');
    claim.dataset.label = '模型自述';
    row.append(target, served, provider, cost, tokens, claim);
    return row;
  });
  if (!rows.length) {
    const row = text('tr', '', 'empty-row');
    const message = running.length ? `正在核对 ${running.join('、')}，结果稍后出现。` : '还没有核对记录。填入完整模型 ID 后点「核对当前路由」。';
    const cell = text('td', message, 'empty-state');
    cell.colSpan = 6; row.append(cell); rows.push(row);
  }
  $('#routeResults').replaceChildren(...rows);
}
function changeRoute() { $('#routeStatus').textContent = ''; renderControls(); }
$('#routeModel').oninput = changeRoute;
$('#routeEffort').onchange = changeRoute;
$('#routeRun').onclick = () => pending($('#routeRun'), async () => {
  if (!requireGateway()) return;
  const model = $('#routeModel').value.trim();
  $('#routeStatus').textContent = `正在向 ${model} 发送一次探测请求…`;
  await request('/api/route/check', { model, effort: $('#routeEffort').value });
  feedback('已开始核对路由', true);
  await refresh();
  $('#routeStatus').textContent = routeRunning(model) ? '核对进行中，结果会稍后出现在下表。' : '';
});
$('#routeClear').onclick = () => pending($('#routeClear'), async () => {
  if (!(data?.state.routes || []).length) return;
  if (!confirm('清理全部路由核对结果？网关请求日志与质量检测记录不受影响。')) return;
  await request('/api/route/clear', {});
  feedback('路由核对结果已清理', true);
  await refresh();
});
$('#routeExport').onclick = () => {
  if (!data) return;
  const payload = { exported_at: new Date().toISOString(), routes: data.state.routes || [] };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'intelligence-check-routes.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
async function loadUsage() {
  const button = $('#usageLoad');
  button.disabled = true;
  try {
    const result = await request('/api/usage?limit=200');
    const rows = result.rows || [];
    $('#usagePathLabel').textContent = result.path || '';
    const cells = rows.map(entry => {
      const row = document.createElement('tr');
      const raw = entry.t || '';
      const when = raw ? new Date(raw).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
      const served = entry.served || '';
      const diff = served && entry.req && served !== entry.req;
      const status = entry.status ? String(entry.status) : '—';
      const statusCell = text('td', status + (entry.err ? ' / ' + entry.err.slice(0, 40) : ''), 'numeric' + (status.startsWith('2') ? '' : ' error-text'));
      row.append(
        text('td', when, 'numeric'),
        text('td', entry.agent || '—', ''),
        text('td', entry.req || '—', 'model-id'),
        text('td', served || '—', 'route-actual ' + (diff ? 'diff' : 'match')),
        text('td', entry.provider || '—', ''),
        text('td', entry.account || '—', ''),
        statusCell,
      );
      return row;
    });
    if (!cells.length) {
      const row = text('tr', '', 'empty-row');
      const cell = text('td', '请求日志里没有可用记录', 'empty-state');
      cell.colSpan = 7; row.append(cell); cells.push(row);
    }
    $('#usageRows').replaceChildren(...cells);
    feedback(`已读取 ${rows.length} 条请求回执`, true);
  } catch (error) {
    const row = text('tr', '', 'empty-row');
    const cell = text('td', error.message, 'empty-state');
    cell.colSpan = 7; row.append(cell); $('#usageRows').replaceChildren(row);
    feedback(error.message);
  } finally { button.disabled = false; }
}
$('#usageLoad').onclick = loadUsage;
function renderTestAnswer() {
  if (!data) return;
  const model = $('#model').value, prompt = $('#prompt').value;
  const submissionError = testErrors.get(JSON.stringify([model, prompt]));
  const records = data.state.results.filter(r => r.model === model && r.prompt === prompt).reverse();
  if (awaitingTest?.model === model && awaitingTest.prompt === prompt && records.some(r => !awaitingTest.ids.has(r.id))) awaitingTest = undefined;
  const waiting = awaitingTest?.model === model && awaitingTest.prompt === prompt;
  syncSelect($('#testRecord'), [['', '最新回答'], ...records.map(r => [r.id, `${dateTime(r.time)} / ${names[r.verdict] || r.verdict}`])]);
  $('#testRecord').disabled = waiting || !records.length;
  const record = waiting ? undefined : records.find(r => r.id === $('#testRecord').value) || records[0];
  const running = waiting || record?.verdict === 'running';
  $('#cancelTest').hidden = !data.state.results.some(r => r.model === model && r.verdict === 'running' && r.prompt !== 'modeltrace');
  const answer = record?.answer || '';
  const elapsed = record ? Math.max(0, Math.floor((Date.now() - Date.parse(record.time)) / 1000)) : 0;
  const runningEffort = record?.effort || effortFor(model);
  const timeout = ['xhigh', 'max', 'ultra'].includes(runningEffort) ? 540 : runningEffort === 'high' ? 360 : 240;
  $('#testStatus').textContent = running ? `检测进行中，已等待 ${elapsed} 秒（最长 ${timeout} 秒）。` : record ? record.verdict === 'unavailable' ? '检测未完成' : '检测完成' : modelRunning(model) ? '该模型正在运行其他检测。' : '';
  $('#testStatus').className = 'inline-state' + (record?.verdict === 'unavailable' ? ' error' : '');
  const effortNote = record?.effort ? ` / 强度 ${effortLabel(record.effort)}` : ' / 强度未指定';
  const reasoningNote = record?.reasoning_tokens ? ` / 思考 ${record.reasoning_tokens}` : '';
  $('#answerMeta').textContent = record ? `${record.model} / ${dateTime(record.time)} / ${names[record.verdict] || record.verdict} / ${record.tokens || 0} tokens${reasoningNote}${effortNote}` : model ? `${model} / ${data.prompts.find(p => p.id === prompt)?.name || ''}` : '尚未选择测试模型';
  $('#answerError').hidden = !record?.error && !submissionError;
  $('#answerError').textContent = submissionError || record?.error || '';
  const content = answer || (running ? '正在等待模型回答…' : record ? record.error ? '本次请求未返回回答正文。' : '本次回答为空。' : '当前模型和题目暂无回答');
  if ($('#testAnswer').textContent !== content) $('#testAnswer').textContent = content;
  $('#testAnswer').setAttribute('aria-busy', String(Boolean(running)));
  $('#copyAnswer').disabled = !answer;
  $('#downloadAnswer').hidden = !answer;
  if (record) $('#downloadAnswer').href = '/api/results/' + encodeURIComponent(record.id) + '/download';
  const review = $('#answerReview');
  review.hidden = !answer || running;
  if (shownRecord !== record?.id) { reviewDirty = false; $('#reviewMessage').textContent = ''; }
  shownRecord = record?.id;
  if (record && !reviewDirty) {
    review.elements.decision.value = record.review || 'pending';
    review.elements.note.value = record.review_note || '';
  }
  $('#reviewStatus').textContent = record?.review ? ({ accepted: '已确认通过', rejected: '已标记问题', pending: '待确认' }[record.review] + ' / ' + dateTime(record.reviewed_at)) : '未审核';
  const signature = JSON.stringify([record?.id, record?.answer, record?.error, record?.verdict]);
  if (analysisSignature !== signature) {
    analysisSignature = signature;
    renderSVGPreview(running ? undefined : record);
    renderHTMLPreview(running ? undefined : record);
    const panel = $('#answerAnalysis'); panel.replaceChildren(); panel.hidden = !answer;
    if (answer) {
      panel.append(text('h3', '自动辅助检查'));
      for (const [label, value] of analyzeAnswer(record, data.prompts.find(p => p.id === prompt))) {
        const row = text('div', '', 'analysis-row'); row.append(text('span', label, 'muted'), text('span', value)); panel.append(row);
      }
    }
  }
}
function showPrompt() {
  $('#promptText').textContent = data?.prompts.find(p => p.id === $('#prompt').value)?.text || '';
  $('#guidance').textContent = data?.guidance?.[$('#prompt').value] || '';
}
function dayCount(model) {
  const day = new Date().toISOString().slice(0, 10);
  const cleared = data.state.cleared_usage?.[day] || {};
  return data.state.results.filter(r => (!model || r.model === model) && new Date(r.time).toISOString().slice(0, 10) === day).length + (model ? cleared[model] || 0 : Object.values(cleared).reduce((a, b) => a + b, 0));
}
function validPass(target) { return target.enabled && target.state === 'passed' && Date.now() - Date.parse(target.checked_at) < 900000; }
function renderTargets() {
  const targets = Object.values(data.state.targets);
  const strict = data.state.config.gate_mode === 'strict';
  const signature = JSON.stringify([targets, strict, data.state.results.filter(r => r.verdict === 'running').map(r => r.model), data.state.config.daily_limit, data.state.config.effort, targets.map(t => [dayCount(t.model), validPass(t), Date.parse(t.allow_until) > Date.now()])]);
  if (signature === targetSignature) return;
  targetSignature = signature;
  const rows = targets.map(target => {
    const row = document.createElement('tr');
    const model = text('td', target.model, 'model-id');
    model.dataset.label = '模型';
    const status = text('td', '');
    status.dataset.label = '状态';
    const allowed = Date.parse(target.allow_until) > Date.now();
    const label = !target.enabled ? '监测关闭' : allowed ? (strict ? '限时放行' : '自动检测暂缓') : target.state === 'passed' && !validPass(target) ? '通过已过期' : names[target.state] || target.state;
    status.append(text('span', label, 'state ' + (target.enabled ? target.state : '')));
    if (target.reason) status.append(text('span', target.reason, 'cell-meta'));
    const effortCell = text('td', '');
    effortCell.dataset.label = '思考强度';
    const select = document.createElement('select');
    select.className = 'effort-select';
    select.setAttribute('aria-label', `${target.model} 的思考强度`);
    fillEffort(select, target.model, `跟随默认${data.state.config.effort ? '（' + effortLabel(data.state.config.effort) + '）' : ''}`);
    select.onchange = () => persistEffort(target.model, select.value, select);
    effortCell.append(select);
    if (target.reasoning === false) effortCell.append(text('span', '网关报告该模型无思考能力', 'cell-meta'));
    else if (target.levels?.length && select.value && !target.levels.includes(select.value)) effortCell.append(text('span', '模型不支持该档位，Magpie 会就近取档', 'cell-meta'));
    const checked = text('td', dateTime(target.checked_at));
    checked.dataset.label = '最近通过';
    const budget = text('td', `${dayCount(target.model)} / ${data.state.config.daily_limit}`, 'numeric');
    budget.dataset.label = '今日预算 (UTC)';
    const actions = text('td', '');
    actions.dataset.label = '操作';
    const tools = text('div', '', 'actions');
    for (const [name, action, image] of [['重新检测', 'test', 'RefreshCw'], [strict ? '放行 15 分钟' : '暂缓自动检测 15 分钟', 'allow', 'Clock3'], [strict ? '暂停' : '标记待确认', 'hold', 'Pause']]) {
      const button = text('button', '', 'icon-button');
      button.type = 'button'; button.append(icon(image));
      button.setAttribute('aria-label', `${name} ${target.model}`);
      button.dataset.tooltip = name; button.title = name;
      button.disabled = (action !== 'test' && !target.enabled) || (action === 'test' && modelRunning(target.model));
      button.onclick = () => pending(button, async () => {
        if (action === 'test' && !requireGateway()) return;
        await request('/api/action', { model: target.model, action });
        feedback(`${target.model}：${action === 'test' ? '已开始检测' : action === 'allow' ? (strict ? '已放行 15 分钟' : '自动检测已暂缓 15 分钟，业务继续通过') : (strict ? '已暂停' : '已标记待确认，业务继续通过')}`, true);
        await refresh();
      });
      tools.append(button);
    }
    const toggle = text('label', '', 'toggle');
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = target.enabled;
    input.setAttribute('aria-label', `监测 ${target.model}`);
    input.onchange = async () => {
      input.disabled = true;
      try { await request('/api/target', { model: target.model, enabled: input.checked }); await refresh(); }
      catch (error) { input.checked = target.enabled; feedback(error.message); }
      finally { input.disabled = false; }
    };
    toggle.append(input, text('span', '', 'toggle-track')); tools.append(toggle); actions.append(tools);
    const remove = text('button', '', 'icon-button'); remove.append(icon('Trash2'));
    remove.setAttribute('aria-label', `删除 ${target.model}`); remove.dataset.tooltip = '删除监测目标'; remove.disabled = modelRunning(target.model);
    remove.onclick = () => {
      if (!confirm(`删除 ${target.model}？该模型将不再受监测门禁限制，历史记录保留。`)) return;
      pending(remove, async () => { await request('/api/target/delete', { model: target.model }); feedback('已删除监测目标，历史记录保留', true); await refresh(); });
    };
    tools.append(remove);
    row.append(model, status, effortCell, checked, budget, actions);
    return row;
  });
  if (!rows.length) {
    const row = text('tr', '', 'empty-row'); const cell = text('td', '添加一个模型开始监测', 'empty-state'); cell.colSpan = 6; row.append(cell); rows.push(row);
  }
  $('#targets').replaceChildren(...rows);
}
function filteredHistory() {
  return [...data.state.results].reverse().filter(r => (!$('#historyModel').value || r.model === $('#historyModel').value) && (!$('#historyVerdict').value || r.verdict === $('#historyVerdict').value) && (!$('#historyPrompt').value || r.prompt === $('#historyPrompt').value) && (!$('#historyReview').value || (r.review || 'pending') === $('#historyReview').value));
}
function renderHistory() {
  if (!data) return;
  syncSelect($('#historyPrompt'), [['', '全部题目'], ...data.prompts.map(p => [p.id, p.name]), ['modeltrace', 'ModelTrace']]);
  const filtered = filteredHistory();
  const candidates = filtered.filter(r => r.answer && r.verdict !== 'running');
  for (const side of ['A', 'B']) syncSelect($('#compare' + side), [['', '选择回答'], ...candidates.map(r => [r.id, `${r.model} / ${r.prompt} / ${dateTime(r.time)}`])]);
  renderComparison();
  $('#historyCount').textContent = `${filtered.length} 条记录`;
  $('#loadHistory').hidden = filtered.length <= historyLimit;
  const records = filtered.slice(0, historyLimit);
  const signature = JSON.stringify(records);
  if (signature === historySignature) return;
  historySignature = signature;
  const expanded = new Set([...$('#results').querySelectorAll('details[open]')].map(d => d.dataset.id));
  $('#results').replaceChildren(...records.map(record => {
    const details = text('details', '', 'record'); details.dataset.id = record.id; details.open = expanded.has(record.id);
    const summary = text('summary', '', 'history-summary');
    summary.append(text('span', dateTime(record.time), 'record-date'), text('span', record.model, 'record-model model-id'), text('span', data.prompts.find(p => p.id === record.prompt)?.name || 'ModelTrace', 'record-type'), text('span', names[record.verdict] || record.verdict, 'state ' + record.verdict), text('span', `${record.tokens || 0} tokens`, 'record-tokens numeric'));
    const body = text('div', '', 'record-body');
    if (record.error) body.append(text('p', record.error, 'inline-state error'));
    if (record.review) body.append(text('p', `人工审核：${({accepted:'确认通过', rejected:'标记问题', pending:'待确认'})[record.review]}${record.review_note ? ' / ' + record.review_note : ''}`, 'inline-state'));
    const effortMeta = [record.effort ? `强度 ${effortLabel(record.effort)}` : '强度未指定', record.reasoning_tokens ? `思考 ${record.reasoning_tokens} tokens` : ''].filter(Boolean).join(' / ');
    body.append(text('p', effortMeta, 'meta'));
    body.append(text('pre', record.answer || (record.verdict === 'running' ? '等待回答' : '未返回回答正文')));
    const download = text('a', '下载原始回答', 'download'); download.prepend(icon('Download'));
    download.href = '/api/results/' + encodeURIComponent(record.id) + '/download'; body.append(download);
    const prompt = record.prompt_text || data.prompts.find(p => p.id === record.prompt)?.text;
    if (prompt) body.append(text('p', '提示词原文', 'prompt-label'), text('pre', prompt));
    details.append(summary, body); return details;
  }));
  if (!records.length) $('#results').append(text('p', '暂无符合条件的记录', 'empty-state'));
}
function renderComparison() {
  for (const side of ['A', 'B']) {
    const record = data?.state.results.find(r => r.id === $('#compare' + side).value);
    $('#compareText' + side).textContent = record?.answer || '尚未选择回答';
    $('#compareMeta' + side).textContent = record ? `${record.model} / ${record.prompt} / ${dateTime(record.time)} / ${record.tokens || 0} tokens / ${{accepted:'确认通过', rejected:'标记问题', pending:'待确认'}[record.review || 'pending']}${record.review_note ? ' / ' + record.review_note : ''}` : '';
  }
}
$('#compareA').onchange = $('#compareB').onchange = renderComparison;
async function refresh() {
  if (polling || stopped) return;
  polling = true;
  try {
    data = await request('/api/state');
    if (pollError && $('#message').textContent === pollError) feedback('');
    pollError = '';
    $('#health').textContent = data.health ? '服务异常' : data.gateway_configured ? '网关已配置' : '等待连接';
    $('#health').className = 'service-state ' + (data.health ? 'warning' : data.gateway_configured ? 'connected' : '');
    $('#health').title = data.health || '';
    $('#connectionNotice').hidden = data.gateway_configured;
    $('#keyState').textContent = data.gateway_configured ? 'Key 已保存；留空保留已保存的 Key。' : '尚未保存 Key；本机默认 Key 为 magpie。';
    $('#logHealth').textContent = data.log_health;
    $('#usageHealth').textContent = data.usage_health + (data.usage_path ? '：' + data.usage_path : '');
    const gateStrict = data.state.config.gate_mode === 'strict';
    const gateScope = data.state.config.gate_agents || '全部 harness';
    $('#gateState').textContent = gateStrict
      ? `强制门禁 · ${gateScope}：未检测、检测中、异常或过期时会拒绝请求。其他客户端可在设置中排除。`
      : `仅检测 · ${gateScope}：业务请求继续通过，后台检测结果供参考；人工暂停也不会阻断业务。`;
    if (!configDirty) {
      for (const key of ['gateway_url', 'log_path', 'daily_limit', 'usage_path']) config.elements[key].value = data.state.config[key] || '';
      syncSelect(config.elements.effort, [['', '不指定（交给 Magpie）'], ...knownLevels().map(level => [level, effortLabel(level)])]);
      config.elements.effort.value = data.state.config.effort || '';
      config.elements.gate_mode.value = data.state.config.gate_mode || 'observe';
      config.elements.gate_agents.value = data.state.config.gate_agents || '';
      $('#effortHint').textContent = data.state.config.effort
        ? `所有未单独设置的模型使用 ${effortLabel(data.state.config.effort)}；探针请求会发送 reasoning_effort。`
        : '不指定时不发送 reasoning_effort，由 Magpie 和各上游使用自己的默认强度。';
    }
    const targets = Object.values(data.state.targets);
    $('#targetCount').textContent = targets.length;
    $('#statEnabled').textContent = targets.filter(t => t.enabled).length;
    $('#statPassed').textContent = targets.filter(validPass).length;
    $('#statReview').textContent = targets.filter(t => t.enabled && ['review', 'unavailable'].includes(t.state)).length;
    $('#statRequests').textContent = dayCount();
    syncSelect($('#model'), targets.map(t => [t.model, t.model + (t.enabled ? '' : '（监测关闭）')]));
    syncSelect($('#prompt'), data.prompts.map(p => [p.id, p.name]));
    syncSelect($('#historyModel'), [['', '全部模型'], ...[...new Set([...targets.map(t => t.model), ...data.state.results.map(r => r.model)])].map(m => [m, m])]);
    showPrompt(); renderTargets(); renderControls(); renderHistory();
    $('#lastSync').textContent = '更新于 ' + dateTime(new Date().toISOString());
  } catch (error) {
    pollError = error.message; feedback(pollError);
    $('#health').textContent = '连接中断'; $('#health').className = 'service-state warning';
  } finally { polling = false; }
}
function changeTest() { $('#testRecord').value = ''; showPrompt(); renderControls(); }
$('#prompt').onchange = changeTest;
$('#model').onchange = changeTest;
$('#testRecord').onchange = renderTestAnswer;
// Picking a level stores it for this model and applies to every later run.
$('#effort').onchange = () => persistEffort($('#model').value, $('#effort').value, $('#effort'));
$('#traceEffort').onchange = () => persistEffort($('#traceModel').value, $('#traceEffort').value, $('#traceEffort'));
$('#refreshEffort').onclick = () => pending($('#refreshEffort'), async () => {
  if (!requireGateway()) return;
  const result = await request('/api/effort/discover', {});
  feedback(result.missing?.length
    ? `已更新 ${result.updated} 个模型的思考档位；网关未列出：${result.missing.join('、')}`
    : `已更新 ${result.updated} 个模型的思考档位`, !result.missing?.length);
  await refresh();
});
$('#answerReview').oninput = () => { reviewDirty = true; };
$('#answerReview').onsubmit = event => {
  event.preventDefault();
  const id = shownRecord;
  const values = Object.fromEntries(new FormData(event.target));
  pending(event.target.querySelector('button'), async () => {
    await request('/api/results/' + encodeURIComponent(id) + '/review', values);
    if (shownRecord === id) { reviewDirty = false; $('#reviewMessage').textContent = '审核已保存'; }
    await refresh();
  }, $('#reviewMessage'));
};
$('#copyAnswer').onclick = () => pending($('#copyAnswer'), async () => {
  await navigator.clipboard.writeText($('#testAnswer').textContent);
  feedback('回答已复制', true);
});
for (const id of ['historyModel', 'historyVerdict', 'historyPrompt', 'historyReview']) $('#' + id).onchange = () => { historyLimit = 30; renderHistory(); };
$('#exportHistory').onclick = () => {
  if (!data) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify({ exported_at: new Date().toISOString(), results: filteredHistory() }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'intelligence-check-results.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('#clearHistory').onclick = () => pending($('#clearHistory'), async () => {
  const records = filteredHistory();
  if (!records.length) return;
  if (!confirm(`永久清理当前筛选的 ${records.length} 条记录？原始回答与审核将删除，已消耗预算和模型门禁保持不变。`)) return;
  await request('/api/results/clear', { ids: records.map(r => r.id) });
  await refresh();
  feedback('记录已清理，预算与模型门禁保持不变', true);
});
$('#loadHistory').onclick = () => { historyLimit += 30; renderHistory(); };
$('#run').onclick = () => pending($('#run'), async () => {
  if (!requireGateway()) return;
  const model = $('#model').value, prompt = $('#prompt').value;
  testErrors.delete(JSON.stringify([model, prompt]));
  awaitingTest = { model, prompt, ids: new Set(data.state.results.map(r => r.id)) };
  $('#testRecord').value = ''; renderTestAnswer();
  const level = effortFor(model);
  try {
    await request('/api/action', { model, action: 'test', prompt });
    feedback(`已开始检测（强度 ${level ? effortLabel(level) : '未指定'}）`, true); await refresh();
  } catch (error) {
    awaitingTest = undefined;
    testErrors.set(JSON.stringify([model, prompt]), error.message);
    renderTestAnswer();
    throw error;
  }
});
$('#cancelTest').onclick = () => pending($('#cancelTest'), async () => {
  await request('/api/action', { model: $('#model').value, action: 'cancel-test' });
  await refresh();
});
$('#traceRun').onclick = () => pending($('#traceRun'), async () => {
  if (!requireGateway()) return;
  await runModelTrace(request); feedback('已开始三条指纹挑战', true); await refresh();
});
$('#loadModels').onclick = () => pending($('#loadModels'), async () => {
  if (!requireGateway()) return;
  const models = await request('/api/models');
  $('#catalog').replaceChildren(...models.map(m => { const option = text('option', m.group); option.value = m.id; return option; }));
  feedback(`已读取 ${models.length} 个模型`, true);
});
$('#target').onsubmit = event => {
  event.preventDefault();
  const form = event.target;
  pending(form.querySelector('button:last-child'), async () => {
    await request('/api/target', { model: form.elements.model.value.trim(), enabled: true });
    form.reset(); feedback('已添加监测目标', true); await refresh();
  });
};
async function saveConfig() {
  const values = Object.fromEntries(new FormData(config)); values.daily_limit = Number(values.daily_limit);
  await request('/api/config', values);  config.elements.gateway_key.value = ''; config.elements.gateway_key.type = secretType;
  $('#showKey').replaceChildren(icon('Eye'));
  $('#showKey').setAttribute('aria-label', '显示输入的 Key');
  $('#showKey').dataset.tooltip = '显示输入的 Key';
  configDirty = false; await refresh();
}
async function checkConnection() {
  const result = await request('/api/connection/check', {});
  $('#configMessage').textContent = `连接成功：${result.model_count} 个模型`;
  $('#configMessage').className = 'inline-state success';
}
config.onsubmit = event => {
  event.preventDefault();
  pending(config.querySelector('button.primary'), async () => {
    await saveConfig();
    $('#configMessage').textContent = '设置已保存，正在验证连接…';
    await checkConnection();
  }, $('#configMessage'));
};
$('#checkConnection').onclick = () => pending($('#checkConnection'), async () => {
  if (configDirty || !data?.gateway_configured) {
    $('#configMessage').textContent = '请先保存当前连接设置。'; return;
  }
  await checkConnection();
}, $('#configMessage'));
$('#closeRemote').onclick = () => pending($('#closeRemote'), async () => {
  await request('/api/console/close', {}); stopped = true;
  feedback('远程访问已结束，请从插件重新打开。');
});
await refresh();
setInterval(refresh, 3000);
