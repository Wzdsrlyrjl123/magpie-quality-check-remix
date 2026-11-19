let currentRecord;
let loading;
let readyTimer;
let generation = 0;
const panel = document.querySelector('#htmlPreview');
const host = document.querySelector('#htmlFrameHost');
const status = document.querySelector('#htmlPreviewStatus');
const stop = document.querySelector('#stopHTML');
const reload = document.querySelector('#reloadHTML');
const expand = document.createElement('button');
expand.id = 'expandHTML';
expand.className = 'icon-button';
expand.dataset.icon = 'Monitor';
expand.dataset.tooltip = '放大预览';
expand.setAttribute('aria-label', '放大预览');
expand.setAttribute('aria-pressed', 'false');
reload.before(expand);
function setExpanded(value) {
  panel.classList.toggle('expanded-preview', value);
  expand.setAttribute('aria-pressed', String(value));
  expand.setAttribute('aria-label', value ? '退出放大预览' : '放大预览');
  expand.dataset.tooltip = expand.getAttribute('aria-label');
}
expand.onclick = () => setExpanded(!panel.classList.contains('expanded-preview'));
document.addEventListener('keydown', event => { if (event.key === 'Escape') setExpanded(false); });
const candidate = document.createElement('select');
candidate.id = 'htmlPreviewCandidate';
candidate.setAttribute('aria-label', '预览代码块');
candidate.hidden = true;
reload.before(candidate);
candidate.onchange = startPreview;
const size = document.createElement('select');
size.id = 'htmlPreviewSize';
size.setAttribute('aria-label', '预览尺寸');
for (const [value, label] of [['', '自适应'], ['390', '手机'], ['768', '平板'], ['1280', '桌面']]) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  size.append(option);
}
reload.before(size);
function resizePreview() {
  const frame = host.querySelector('iframe');
  if (frame) frame.style.width = size.value ? `${size.value}px` : '100%';
}
size.onchange = resizePreview;
export function stopHTMLPreview() {
  setExpanded(false);
  generation++;
  loading?.abort();
  loading = undefined;
  clearTimeout(readyTimer);
  host.replaceChildren();
  stop.disabled = true;
  if (currentRecord) status.textContent = '预览已停止';
}
async function startPreview() {
  stopHTMLPreview();
  if (!currentRecord || document.querySelector('#view-tests').hidden) return;
  const ticket = generation;
  const controller = new AbortController();
  loading = controller;
  const url = './api/results/' + encodeURIComponent(currentRecord.id) + '/preview' + (candidate.value ? '?candidate=' + candidate.value : '');
  status.textContent = '正在加载…';
  stop.disabled = false;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const message = await response.text();
      if (response.status === 401) throw Error('管理会话已失效，请从 Magpie 插件重新打开控制台。');
      throw Error(/<!doctype|<html/i.test(message) ? `预览连接失败（HTTP ${response.status}）` : message.trim() || `预览加载失败（HTTP ${response.status}）`);
    }
    await response.body?.cancel();
    if (ticket !== generation) return;
    const count = Number(response.headers.get('X-Preview-Candidates'));
    const combined = response.headers.get('X-Preview-Combined') === 'true';
    const previous = candidate.value;
    candidate.replaceChildren(...Array.from({ length: count }, (_, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = combined && index === count - 1 ? '组合 HTML + CSS / JS' : `HTML ${index + 1}`;
      return option;
    }));
    if (previous) candidate.value = previous;
    candidate.hidden = count < 2;
    const frame = document.createElement('iframe');
    frame.title = '模型生成的 HTML 实时预览';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    frame.src = url;
    host.append(frame);
    resizePreview();
    readyTimer = setTimeout(() => {
      if (ticket === generation) status.textContent = '预览未确认加载，请重新加载或查看原始回答。';
    }, 15000);
  } catch (error) {
    if (ticket !== generation || error.name === 'AbortError') return;
    status.textContent = error.message;
    stop.disabled = true;
  } finally {
    if (loading === controller) loading = undefined;
  }
}
window.addEventListener('message', event => {
  const frame = host.querySelector('iframe');
  if (!frame || event.source !== frame.contentWindow || event.data?.type !== 'intelligence-preview-ready') return;
  clearTimeout(readyTimer);
  status.textContent = '预览已加载';
});
stop.onclick = stopHTMLPreview;
reload.onclick = startPreview;
export function renderHTMLPreview(record) {
  stopHTMLPreview();
  currentRecord = undefined;
  candidate.replaceChildren();
  candidate.hidden = true;
  panel.hidden = true;
  if (record?.prompt !== 'html' || !record.answer) return;
  panel.hidden = false;
  currentRecord = record;
  reload.disabled = false;
  startPreview();
}
