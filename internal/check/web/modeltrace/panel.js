import { analyzeGlobalOutputs } from './fingerprint-core.js';
import { $, text, syncSelect, dateTime } from '../assets/ui.js';

let bank, bankLoading, latestData, rendered;
const percent = value => `${(value * 100).toFixed(1)}%`;

export async function runModelTrace(request) {
  const model = $('#traceModel').value;
  if (!model) throw Error('请先添加监测模型。');
  await request('./api/action', { model, action: 'modeltrace' });
}
$('#traceModel').onchange = $('#traceBatch').onchange = () => renderModelTrace(latestData);

export function renderModelTrace(data) {
  if (!data) return;
  latestData = data;
  const select = $('#traceModel');
  syncSelect(select, Object.values(data.state.targets).map(t => [t.model, t.model + (t.enabled ? '' : '（监测关闭）')]));
  const records = data.state.results.filter(r => r.prompt === 'modeltrace' && r.model === select.value);
  const batches = [...new Set(records.map(r => r.batch))].reverse();
  syncSelect($('#traceBatch'), [['', '最新批次'], ...batches.map(batch => [batch, dateTime(records.find(r => r.batch === batch).time)])]);
  const batch = $('#traceBatch').value || batches[0];
  const results = records.filter(r => r.batch === batch);
  $('#traceRun').disabled = $('#traceRun').hasAttribute('aria-busy') || !select.value || data.state.results.some(r => r.model === select.value && r.verdict === 'running');
  const signature = JSON.stringify([select.value, results, Boolean(bank)]);
  if (signature === rendered) return;
  rendered = signature;
  const panel = $('#traceResults');
  const expanded = panel.querySelector('details')?.open;
  panel.replaceChildren();
  if (!batch) { panel.append(text('p', '暂无指纹检测记录', 'empty-state')); return; }
  const complete = results.filter(r => r.verdict !== 'running').length;
  const progress = text('div', '', 'trace-progress');
  const segments = text('div', '', 'segments'); segments.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) {
    const result = results[i];
    segments.append(text('span', '', 'segment' + (!result || result.verdict === 'running' ? '' : result.verdict === 'manual' ? ' complete' : ' failed')));
  }
  progress.append(segments, text('span', `${complete}/3 完成`, 'numeric'), text('span', dateTime(results[0].time), 'meta'));
  panel.append(progress);
  if (results.some(r => r.verdict === 'running')) { panel.append(text('p', '正在等待模型回答…', 'muted')); return; }
  if (results.length !== 3 || results.some(r => r.verdict !== 'manual')) {
    panel.append(text('p', '本轮检测不可用：' + (results.find(r => r.error)?.error || '缺少三条完整回答')));
    return;
  }
  if (!bank) {
    panel.append(text('p', '正在读取指纹库', 'muted'));
    if (!bankLoading) {
      bankLoading = fetch('./modeltrace/unified_bank.json').then(async response => {
        if (!response.ok) throw Error(`指纹库读取失败（HTTP ${response.status}）。`);
        bank = await response.json(); rendered = undefined; renderModelTrace(latestData);
      }).catch(error => {
        panel.replaceChildren(text('p', error.message));
        const retry = text('button', '重新读取', 'secondary');
        retry.onclick = () => { rendered = undefined; renderModelTrace(latestData); }; panel.append(retry);
      }).finally(() => { bankLoading = undefined; });
    }
    return;
  }
  try {
    const report = analyzeGlobalOutputs(results.map(r => ({ text: r.answer, expected_count: r.expected_count })), bank);
    if (report.used_outputs !== 3) { panel.append(text('p', `仅 ${report.used_outputs}/3 条有效数字回答，本轮不作归因。`)); return; }
    const reportNode = text('div', '', 'trace-report');
    for (const [label, name, probability] of [['最相似候选', report.prediction_name, report.probability], ['最相似家族', report.family_prediction_name, report.family_probability]]) {
      const item = text('div', '', 'trace-prediction');
      item.append(text('span', label, 'label'), text('span', name, 'prediction'), text('span', percent(probability), 'probability')); reportNode.append(item);
    }
    panel.append(reportNode);
    const candidates = text('div', '', 'candidate-list');
    for (const candidate of report.results.slice(0, 3)) {
      const row = text('div', '', 'candidate-row'); const bar = text('div', '', 'bar');
      const fill = text('span', ''); fill.style.width = percent(candidate.probability); bar.append(fill);
      row.append(text('span', candidate.display_name, 'model-id'), bar, text('span', percent(candidate.probability), 'numeric')); candidates.append(row);
    }
    panel.append(candidates);
    const details = document.createElement('details'); details.open = Boolean(expanded);
    details.append(text('summary', `全部 ${report.results.length} 个候选`));
    const table = text('table', '', 'ranking');
    const header = document.createElement('tr'); header.append(text('th', '候选模型'), text('th', '家族'), text('th', '闭集概率'));
    const head = document.createElement('thead'); head.append(header);
    const body = document.createElement('tbody');
    for (const candidate of report.results) {
      const row = document.createElement('tr'); row.append(text('td', candidate.display_name), text('td', candidate.family_name), text('td', percent(candidate.probability))); body.append(row);
    }
    table.append(head, body); details.append(table); panel.append(details);
  } catch (error) { panel.append(text('p', `本轮无法归因：${error.message}`)); }
}
