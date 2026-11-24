import { h, clear, toast, copyText } from './dom.js';
import { createKvEditor } from './kvEditor.js';
import { renderJsonTree, treeStats } from './jsonTree.js';
import { renderDiff } from './diffView.js';
import { parse } from './losslessJson.js';
import { splitUrl, joinUrl, formatJson, jsonToFields, fieldsToJson } from './convert.js';
import { parseCurl } from './curl.js';
import { loadVars, saveVars, applyVars, makeVarsApi, varMap, substitute } from './vars.js';
import { runPre, runPost, MAX_SCRIPT_LOG_LINES } from './scripts.js';
import { sendRequest, sendBatch, exitApp, base64ToBytes, bytesToText, formatSize } from './api.js';

const $ = (id) => document.getElementById(id);
const DRAFT_KEY = 'httpt.draft';
const HIST_KEY = 'httpt.history';
const HIST_MAX = 10;
const BODY_CAP = 512 * 1024;
const MAX_BINARY_FILE_BYTES = 128 * 1024 * 1024;
const MAX_FORM_FILE_BYTES = 160 * 1024 * 1024;
const DEFAULT_FILE_LIMIT_MB = 1;

const state = {
  method: 'GET',
  url: '',
  headers: [],
  query: [],
  bodyType: 'none',
  body: '',
  formFields: [],
  binary: null,
  fileLimitMb: DEFAULT_FILE_LIMIT_MB,
  timeoutMs: 30000,
  followRedirects: true,
  insecure: false,
  preScript: '',
  postScript: '',
};

let vars = loadVars();
let history = loadHistory();
let lastResponse = null;
let lastRequestedUrl = '';
let scriptLogs = { pre: [], post: [] };
let scriptLogDropped = { pre: 0, post: 0 };
let abortController = null;
let expandDepth = 2;
let syncing = false;
let draftTimer = null;
let draftPersistWarned = false;
let binaryReadVersion = 0;
let closeConfirmed = false;

const paramsEditor = createKvEditor($('paramsEditor'), {
  keyPlaceholder: '参数名（支持 {{变量}}）',
  valuePlaceholder: '参数值（支持 {{变量}}）',
  onChange: (rows) => {
    state.query = rows;
    syncParamsToUrl();
    saveDraft();
  },
});
const headersEditor = createKvEditor($('headersEditor'), {
  keyPlaceholder: 'Header 名（支持 {{变量}}）',
  valuePlaceholder: 'Header 值（支持 {{变量}}）',
  onChange: (rows) => {
    state.headers = rows;
    saveDraft();
  },
});
const formEditor = createKvEditor($('formEditor'), {
  allowFiles: true,
  keyPlaceholder: '字段名（支持 {{变量}}）',
  valuePlaceholder: '字段值（支持 {{变量}}）',
  onChange: (rows) => {
    state.formFields = rows;
    saveDraft();
  },
});
const varsEditor = createKvEditor($('varsEditor'), {
  keyPlaceholder: '变量名',
  valuePlaceholder: '变量值',
  onChange: (rows) => {
    vars = rows;
    if (!saveVars(vars)) {
      toast('变量未持久化：应用存储空间已满', 'error');
    }
    updateCounts();
  },
});

function updateCounts() {
  $('varsCount').textContent = vars.filter((v) => v.enabled !== false && v.key).length || '';
  $('histCount').textContent = history.length || '';
}

function clampFileLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_FILE_LIMIT_MB;
  return Math.min(128, Math.max(1, Math.round(parsed)));
}

function fileLimitBytes() {
  return state.fileLimitMb * 1024 * 1024;
}

function uploadLimitError(fileSize) {
  return `单个文件 ${formatSize(fileSize)} 超过上限 ${formatSize(fileLimitBytes())}；请在 Body 区调整“单次上传上限”后重试`;
}

function base64ByteLength(value) {
  if (!value) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

function writeDraft() {
  try {
    const draft = {
      ...state,
      formFields: state.formFields.map((f) =>
        f.kind === 'file' ? { ...f, base64: undefined, fileMissing: !!f.fileName } : f
      ),
      binary: state.binary ? { ...state.binary, base64: undefined, fileMissing: true } : null,
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    draftPersistWarned = false;
  } catch {
    if (!draftPersistWarned) {
      draftPersistWarned = true;
      toast('草稿未持久化：应用存储空间已满', 'error');
    }
  }
}

function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(writeDraft, 300);
}

function flushDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  writeDraft();
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const draft = JSON.parse(raw);
    Object.assign(state, draft);
    state.fileLimitMb = clampFileLimit(state.fileLimitMb);
  } catch {
    /* 草稿损坏则用默认值 */
  }
}

function syncUrlToParams() {
  if (syncing) return;
  syncing = true;
  const { pairs } = splitUrl(state.url);
  state.query = pairs;
  paramsEditor.setRows(pairs, true);
  syncing = false;
}

function syncParamsToUrl() {
  if (syncing) return;
  syncing = true;
  const { base, hash } = splitUrl(state.url);
  state.url = joinUrl(base, state.query, hash);
  $('url').value = state.url;
  syncing = false;
}

function updateBodyUI() {
  const t = state.bodyType;
  $('bodyText').style.display = t === 'json' || t === 'raw' ? '' : 'none';
  $('formEditor').style.display = t === 'form' || t === 'urlencoded' ? '' : 'none';
  $('binaryBox').style.display = t === 'binary' ? '' : 'none';
  $('fileLimitBox').style.display = t === 'form' || t === 'binary' ? '' : 'none';
  formEditor.setFileLimits({ maxFileBytes: fileLimitBytes(), maxTotalFileBytes: MAX_FORM_FILE_BYTES });
  $('btnFormat').style.display = t === 'json' ? '' : 'none';
  $('btnToForm').style.display = t === 'json' ? '' : 'none';
  $('btnToUrlencoded').style.display = t === 'json' ? '' : 'none';
  $('btnToJson').style.display = t === 'form' || t === 'urlencoded' ? '' : 'none';
  const binName = state.binary && state.binary.fileName;
  $('binaryInfo').textContent = binName
    ? `${binName}（${formatSize(state.binary.fileSize || 0)}）${state.binary.fileMissing ? ' [需重新选择文件]' : ''}`
    : '';
}

function applyRequestToUI() {
  $('method').value = state.method;
  $('url').value = state.url;
  $('timeout').value = state.timeoutMs;
  $('followRedirects').checked = state.followRedirects;
  $('insecure').checked = state.insecure;
  $('bodyType').value = state.bodyType;
  $('fileLimit').value = state.fileLimitMb;
  $('bodyText').value = state.body;
  $('preScript').value = state.preScript;
  $('postScript').value = state.postScript;
  paramsEditor.setRows(state.query, true);
  headersEditor.setRows(state.headers, true);
  formEditor.setRows(state.formFields, true);
  updateBodyUI();
}

function wireTabs(navId) {
  const nav = $(navId);
  const section = nav.closest('section');
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    section.querySelectorAll('[data-panel]').forEach((p) => {
      p.classList.toggle('active', p.dataset.panel === btn.dataset.tab);
    });
  });
}

function switchRespTab(name) {
  const nav = $('respTabs');
  nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('responsePane').querySelectorAll('[data-panel]').forEach((p) => {
    p.classList.toggle('active', p.dataset.panel === name);
  });
}

function makeResApi(res) {
  let parsed;
  let parseErr;
  return {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    getHeader(name) {
      const hit = res.headers.find((x) => x.key.toLowerCase() === String(name).toLowerCase());
      return hit ? hit.value : undefined;
    },
    bodyText: res.bodyText,
    timeMs: res.timeMs,
    sizeBytes: res.sizeBytes,
    finalUrl: res.finalUrl,
    truncated: res.truncated,
    text() {
      return res.bodyText;
    },
    json() {
      if (parseErr) throw parseErr;
      if (parsed === undefined) {
        try {
          parsed = parse(res.bodyText);
        } catch (e) {
          parseErr = e;
          throw e;
        }
      }
      return parsed;
    },
  };
}

function setSending(on) {
  $('btnSend').disabled = on;
  $('btnCancel').hidden = !on;
  $('btnSend').textContent = on ? '请求中…' : '发送';
  $('btnBatch').disabled = on;
  $('btnCurl').disabled = on;
}

function renderRespMeta(res) {
  const box = clear($('respMeta'));
  box.classList.remove('muted');
  if (!res) {
    box.classList.add('muted');
    box.textContent = '尚未发送请求';
    return;
  }
  if (!res.ok) {
    box.append(h('span', { class: 'status-chip s0xx' }, 'ERROR'));
    box.append(h('span', { class: 'trunc-warn' }, res.error || '请求失败'));
    box.append(h('span', { class: 'muted' }, `${res.timeMs} ms`));
    return;
  }
  const cls = `s${Math.floor(res.status / 100)}xx`;
  box.append(h('span', { class: `status-chip ${cls}` }, `${res.status} ${res.statusText}`));
  box.append(h('span', {}, `${res.timeMs} ms`));
  box.append(h('span', {}, formatSize(res.sizeBytes)));
  if (res.truncated) box.append(h('span', { class: 'trunc-warn' }, '已截断（>32MB）'));
  if (res.finalUrl && res.finalUrl !== lastRequestedUrl) {
    box.append(h('span', { class: 'final-url' }, `→ ${res.finalUrl}`));
  }
}

function renderPretty(res) {
  const box = clear($('prettyBox'));
  $('longInfo').textContent = '';
  if (!res || !res.ok) {
    if (res && !res.ok) box.append(h('div', { class: 'error-box' }, res.error || '请求失败'));
    return;
  }
  let value;
  try {
    value = parse(res.bodyText);
  } catch {
    if (res.contentType.startsWith('image/') && res.sizeBytes <= 8 * 1024 * 1024) {
      box.append(h('img', { class: 'pretty-img', src: `data:${res.contentType};base64,${res.bodyBase64}`, alt: '响应图片' }));
      return;
    }
    box.append(h('div', { class: 'pretty-note' }, '响应不是合法 JSON，按原文展示：'));
    box.append(h('pre', { class: 'raw' }, res.bodyText));
    return;
  }
  const stats = treeStats(value);
  if (stats.longs > 0) {
    $('longInfo').textContent = `含 ${stats.longs} 个 long 大整数（精确展示）`;
  }
  renderJsonTree(box, value, { showTypes: $('showTypes').checked, expandDepth });
}

function rerenderPretty() {
  if (lastResponse) renderPretty(lastResponse);
}

function renderRaw(res) {
  $('rawBox').textContent = res && res.ok ? res.bodyText : (res && res.error) || '';
}

function renderRespHeaders(res) {
  const box = clear($('respHeadersBox'));
  if (!res || !res.ok || res.headers.length === 0) {
    box.append(h('div', { class: 'muted' }, '无响应头'));
    return;
  }
  const table = h('table', { class: 'resp-headers-table' });
  for (const hd of res.headers) {
    table.append(h('tr', {}, h('td', {}, hd.key), h('td', {}, hd.value)));
  }
  box.append(table);
}

function appendScriptLogs(kind, logs, dropped) {
  for (const line of logs) scriptLogs[kind].push(line);
  scriptLogDropped[kind] = dropped;
}

function renderLogs() {
  const box = clear($('logsBox'));
  const section = (title, logs, dropped) => {
    const sec = h('div', { class: 'log-section' }, h('h4', {}, title));
    if (logs.length === 0) {
      sec.append(h('div', { class: 'muted' }, '无输出'));
    }
    const visible = logs.length > MAX_SCRIPT_LOG_LINES
      ? [...logs.slice(0, MAX_SCRIPT_LOG_LINES - 2), ...logs.slice(-2)]
      : logs;
    for (const line of visible) {
      const time = new Date(line.ts).toLocaleTimeString();
      sec.append(h('div', { class: `log-line ${line.level}` }, h('span', { class: 'ts' }, time), line.text));
    }
    const omitted = dropped + logs.length - visible.length;
    if (omitted > 0) {
      sec.append(h('div', { class: 'muted' }, `仅显示 ${visible.length} 行，已省略 ${omitted} 行`));
    }
    return sec;
  };
  box.append(
    section('前置脚本', scriptLogs.pre, scriptLogDropped.pre),
    section('后置脚本', scriptLogs.post, scriptLogDropped.post),
  );
}

function renderResponse(res) {
  renderRespMeta(res);
  renderPretty(res);
  renderRaw(res);
  renderRespHeaders(res);
  renderLogs();
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HIST_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function persistHistory() {
  let evicted = 0;
  while (history.length > 0) {
    try {
      localStorage.setItem(HIST_KEY, JSON.stringify(history));
      return { ok: true, evicted };
    } catch {
      history.pop();
      evicted += 1;
    }
  }
  try {
    localStorage.removeItem(HIST_KEY);
    return { ok: true, evicted };
  } catch {
    return { ok: false, evicted };
  }
}

function sanitizeRequest(payload) {
  return {
    ...payload,
    formFields: (payload.formFields || []).map((f) =>
      f.kind === 'file' ? { ...f, base64: undefined, fileMissing: !!f.fileName } : f
    ),
    binary: payload.binary ? { ...payload.binary, base64: undefined, fileMissing: true } : null,
    preScript: payload.preScript ?? state.preScript,
    postScript: payload.postScript ?? state.postScript,
  };
}

function pushHistory(payload, res, result) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: Date.now(),
    method: payload.method,
    url: payload.url,
    status: result.ok ? result.status : 0,
    timeMs: result.timeMs,
    sizeBytes: result.sizeBytes,
    contentType: result.contentType || '',
    error: result.error || null,
    bodyText: res && res.bytes.length <= BODY_CAP ? res.bodyText : null,
    request: sanitizeRequest(payload),
  };
  history.unshift(entry);
  if (history.length > HIST_MAX) history.length = HIST_MAX;
  const saved = persistHistory();
  if (!saved.ok) toast('历史记录未持久化：应用存储空间已满', 'error');
  else if (saved.evicted > 0) toast(`存储空间不足，已丢弃 ${saved.evicted} 条最旧历史`, 'error');
  renderHistory();
  refreshDiffSelects();
  updateCounts();
}

function histLabel(e) {
  const time = new Date(e.ts).toLocaleTimeString();
  const url = e.url.length > 48 ? `${e.url.slice(0, 48)}…` : e.url;
  return `${time} ${e.method} ${url} [${e.status || 'ERR'}]`;
}

function renderHistory() {
  const box = clear($('historyList'));
  if (history.length === 0) {
    box.append(h('div', { class: 'muted' }, '暂无记录'));
    return;
  }
  for (const e of history) {
    const item = h('div', { class: 'hist-item' },
      h('div', { class: 'hist-line1' },
        h('span', { class: 'hist-method' }, e.method),
        h('span', { class: `hist-status ${e.status >= 200 && e.status < 400 ? 'ok' : 'err'}` }, e.status || 'ERR'),
        h('span', { class: 'muted' }, `${e.timeMs} ms · ${formatSize(e.sizeBytes || 0)}`),
        h('span', { class: 'muted' }, new Date(e.ts).toLocaleString())),
      h('div', { class: 'hist-url' }, e.url),
      h('div', { class: 'hist-actions' },
        h('button', { class: 'mini', onClick: () => restoreHistory(e) }, '载入请求'),
        h('button', {
          class: 'mini',
          disabled: e.bodyText === null,
          title: e.bodyText === null ? '响应体过大或未保留，无法对比' : '设为对比 A',
          onClick: () => {
            $('diffA').value = e.id;
            switchRespTab('diff');
            closeDrawers();
            toast('已设为对比 A', 'ok');
          },
        }, '设为 A'),
        h('button', {
          class: 'mini',
          disabled: e.bodyText === null,
          title: e.bodyText === null ? '响应体过大或未保留，无法对比' : '设为对比 B',
          onClick: () => {
            $('diffB').value = e.id;
            switchRespTab('diff');
            closeDrawers();
            toast('已设为对比 B', 'ok');
          },
        }, '设为 B'),
        h('button', {
          class: 'mini danger',
          onClick: () => {
            history = history.filter((x) => x.id !== e.id);
            const saved = persistHistory();
            if (!saved.ok) toast('删除未持久化：应用存储空间已满', 'error');
            else if (saved.evicted > 0) toast(`存储空间不足，已丢弃 ${saved.evicted} 条最旧历史`, 'error');
            renderHistory();
            refreshDiffSelects();
            updateCounts();
          },
        }, '删除')));
    box.append(item);
  }
}

function restoreHistory(e) {
  const req = e.request || {};
  const split = splitUrl(req.url || '');
  const query = req.query || split.pairs;
  binaryReadVersion += 1;
  Object.assign(state, {
    method: req.method || 'GET',
    url: joinUrl(split.base, query, split.hash),
    headers: req.headers || [],
    query,
    bodyType: req.bodyType || 'none',
    body: req.body || '',
    formFields: req.formFields || [],
    binary: req.binary || null,
    timeoutMs: Number.isFinite(req.timeoutMs) ? req.timeoutMs : 30000,
    followRedirects: req.followRedirects !== false,
    insecure: !!req.insecure,
    preScript: req.preScript || '',
    postScript: req.postScript || '',
  });
  applyRequestToUI();
  saveDraft();
  closeDrawers();
  toast('已载入历史请求', 'ok');
}

function importCurl() {
  if (abortController) {
    toast('请求仍在运行，请取消或完成后再导入 cURL', 'error');
    return;
  }
  const message = $('curlMessage');
  message.textContent = '';
  message.classList.remove('error');
  try {
    const { request, warnings } = parseCurl($('curlText').value);
    binaryReadVersion += 1;
    Object.assign(state, request);
    applyRequestToUI();
    saveDraft();
    $('curlText').value = '';
    closeDrawers();
    $('url').focus();
    const suffix = warnings.length > 0 ? `；${warnings.join('；')}` : '';
    toast(`已导入 cURL 请求${suffix}`, warnings.length > 0 ? 'info' : 'ok');
  } catch (e) {
    message.textContent = e.message;
    message.classList.add('error');
    $('curlText').focus();
    toast(`导入失败: ${e.message}`, 'error');
  }
}

function refreshDiffSelects() {
  const usable = history.filter((e) => e.bodyText !== null);
  for (const sel of [$('diffA'), $('diffB')]) {
    const prev = sel.value;
    clear(sel);
    sel.append(h('option', { value: '' }, '— 选择响应 —'));
    for (const e of usable) {
      sel.append(h('option', { value: e.id }, histLabel(e)));
    }
    if (usable.some((e) => e.id === prev)) sel.value = prev;
  }
  if (!$('diffA').value && usable[1]) $('diffA').value = usable[1].id;
  if (!$('diffB').value && usable[0]) $('diffB').value = usable[0].id;
}

function runDiff() {
  const a = history.find((e) => e.id === $('diffA').value);
  const b = history.find((e) => e.id === $('diffB').value);
  if (!a || !b) {
    toast('请先选择两份响应（历史记录中保留原文的条目）', 'error');
    return;
  }
  renderDiff($('diffBox'), a.bodyText, b.bodyText);
}

function openDrawer(id) {
  closeDrawers();
  $(id).hidden = false;
  $('drawerMask').hidden = false;
}
function closeDrawers() {
  $('varsDrawer').hidden = true;
  $('historyDrawer').hidden = true;
  $('batchDrawer').hidden = true;
  $('curlDrawer').hidden = true;
  $('drawerMask').hidden = true;
}

function preparePayload() {
  const req = {
    ...state,
    headers: state.headers.map((x) => ({ ...x })),
    query: state.query.map((x) => ({ ...x })),
    formFields: state.formFields.map((x) => ({ ...x })),
    binary: state.binary ? { ...state.binary } : null,
  };
  const historyRequest = {
    ...req,
    headers: req.headers.map((x) => ({ ...x })),
    query: req.query.map((x) => ({ ...x })),
    formFields: req.formFields.map((x) => ({ ...x })),
    binary: req.binary ? { ...req.binary } : null,
  };
  scriptLogs = { pre: [], post: [] };
  scriptLogDropped = { pre: 0, post: 0 };
  const varsApi = makeVarsApi(() => vars, () => {
    varsEditor.setRows(vars, true);
    updateCounts();
  });

  const urlBeforePre = req.url;
  const querySnapshot = JSON.stringify(req.query);
  const pre = runPre(state.preScript, req, varsApi);
  appendScriptLogs('pre', pre.logs, pre.dropped);
  if (pre.error) {
    scriptLogs.pre.push({ level: 'error', text: pre.error.stack || String(pre.error), ts: Date.now() });
  }

  const { req: finalReq, unresolved } = applyVars(req, vars);
  const unresolvedSet = new Set(unresolved);

  // URL 与 Params 是同一份数据的两个视图，查询串来源按优先级：
  // 1. 前置脚本改过 URL：以 URL 为准（脚本对 req.query 的修改会被覆盖，帮助文案已说明）
  // 2. 前置脚本改过 Params：以 Params 为准（URL 中替换后新增的查询串会被丢弃）
  // 3. 都没改：两者本应一致（双向同步 / 历史载入的 base 无查询串），仅当变量展开给 URL
  //    带来了 Params 表没有的查询串时（如 {{endpoint}} 值含 ?a=1）才以替换后的 URL 为准
  // 发送时 URL 只保留 base+hash，查询串统一走 query 数组，避免后端重复追加
  const split = splitUrl(finalReq.url);
  const preTouchedUrl = finalReq.url !== substitute(urlBeforePre, varMap(vars), new Set());
  const preTouchedQuery = JSON.stringify(req.query) !== querySnapshot;
  let querySource;
  if (preTouchedUrl) {
    querySource = split.pairs.map((p) => ({ ...p, value: substitute(p.value, varMap(vars), unresolvedSet) }));
  } else if (preTouchedQuery) {
    querySource = finalReq.query;
  } else {
    const origKeys = splitUrl(urlBeforePre).pairs.map((p) => p.key);
    const grew = split.pairs.length !== origKeys.length
      || split.pairs.some((p, i) => origKeys[i] !== p.key);
    querySource = grew ? split.pairs : finalReq.query;
  }
  const baseUrl = joinUrl(split.base, [], split.hash);
  if (unresolvedSet.size > 0) {
    scriptLogs.pre.push({ level: 'warn', text: `未解析的变量: ${[...unresolvedSet].join(', ')}`, ts: Date.now() });
  }

  let url = baseUrl.trim();
  if (!url) {
    toast('请输入 URL', 'error');
    return null;
  }
  if (!/^[a-zA-Z][\w+.-]*:\/\//.test(url)) url = `http://${url}`;
  lastRequestedUrl = url;

  const missingFile =
    (finalReq.bodyType === 'binary' && (!finalReq.binary || !finalReq.binary.base64)) ||
    (finalReq.bodyType === 'form' &&
      finalReq.formFields.some((f) => f.enabled !== false && f.kind === 'file' && !f.base64));
  if (missingFile) {
    toast('存在未选择文件的文件字段（历史载入后需重新选择）', 'error');
    return null;
  }
  const binarySize = finalReq.bodyType === 'binary'
    ? base64ByteLength(finalReq.binary && finalReq.binary.base64)
    : 0;
  if (binarySize > fileLimitBytes()) {
    toast(uploadLimitError(binarySize), 'error');
    return null;
  }
  const formFiles = finalReq.bodyType === 'form'
    ? finalReq.formFields.filter((f) => f.enabled !== false && f.kind === 'file')
    : [];
  for (const file of formFiles) {
    const size = base64ByteLength(file.base64);
    if (size > fileLimitBytes()) {
      toast(uploadLimitError(size), 'error');
      return null;
    }
  }
  const totalFormBytes = formFiles.reduce((total, file) => total + base64ByteLength(file.base64), 0);
  if (totalFormBytes > MAX_FORM_FILE_BYTES) {
    toast(`表单文件合计 ${formatSize(totalFormBytes)} 超过上限 ${formatSize(MAX_FORM_FILE_BYTES)}，请减少文件`, 'error');
    return null;
  }

  const payload = {
    method: finalReq.method,
    url,
    headers: finalReq.headers,
    query: querySource,
    bodyType: finalReq.bodyType,
    body: finalReq.body,
    formFields: finalReq.formFields,
    binary: finalReq.binary,
    timeoutMs: Math.max(0, Number(finalReq.timeoutMs) || 0),
    followRedirects: finalReq.followRedirects,
    insecure: finalReq.insecure,
  };
  return { payload, varsApi, historyRequest };
}

async function doSend() {
  if (abortController) return;
  const prep = preparePayload();
  if (!prep) {
    renderLogs();
    return;
  }
  const { payload, varsApi, historyRequest } = prep;

  setSending(true);
  abortController = new AbortController();
  let result;
  try {
    result = await sendRequest(payload, abortController.signal);
  } catch (e) {
    abortController = null;
    setSending(false);
    if (e.name === 'AbortError') {
      toast('已取消', 'info');
    } else {
      toast(e.message, 'error');
      lastResponse = { ok: false, error: e.message, timeMs: 0 };
      renderResponse(lastResponse);
    }
    return;
  }
  abortController = null;
  setSending(false);

  if (!result.ok) {
    lastResponse = result;
    renderResponse(result);
    pushHistory(historyRequest, null, result);
    switchRespTab('pretty');
    return;
  }

  const bytes = base64ToBytes(result.bodyBase64);
  const res = { ...result, bytes, bodyText: bytesToText(bytes) };
  lastResponse = res;

  const post = runPost(historyRequest.postScript, makeResApi(res), varsApi);
  appendScriptLogs('post', post.logs, post.dropped);
  if (post.error) {
    scriptLogs.post.push({ level: 'error', text: post.error.stack || String(post.error), ts: Date.now() });
  }

  renderResponse(res);
  pushHistory(historyRequest, res, result);
  switchRespTab('pretty');
}

function setBatchRunning(on) {
  $('btnBatchStart').disabled = on;
  $('btnBatchCancel').hidden = !on;
  $('btnBatch').disabled = on;
  $('btnSend').disabled = on;
  $('btnCurl').disabled = on;
  $('batchRunning').hidden = !on;
}

async function doBatch() {
  if (abortController) return;
  const count = Math.floor(Number($('batchCount').value)) || 0;
  const rounds = Math.floor(Number($('batchRounds').value)) || 0;
  const intervalMs = Math.max(0, Math.floor(Number($('batchInterval').value)) || 0);
  if (count < 1 || rounds < 1 || count > 1000 || rounds > 1000 || count * rounds > 1000) {
    toast('并发数与轮数需为 1-1000，且总请求数（并发数×轮数）≤ 1000', 'error');
    return;
  }
  const prep = preparePayload();
  if (!prep) {
    renderLogs();
    return;
  }
  setBatchRunning(true);
  abortController = new AbortController();
  let result;
  try {
    result = await sendBatch({ ...prep.payload, count, rounds, intervalMs }, abortController.signal);
  } catch (e) {
    abortController = null;
    setBatchRunning(false);
    if (e.name === 'AbortError') toast('已取消', 'info');
    else toast(e.message, 'error');
    return;
  }
  abortController = null;
  setBatchRunning(false);
  renderLogs();
  renderBatch(result);
  switchRespTab('batch');
}

function batchCard(label, value, cls) {
  return h('div', { class: `batch-card ${cls || ''}` },
    h('div', { class: 'batch-card-v' }, String(value)),
    h('div', { class: 'batch-card-l' }, label));
}

function renderBatch(res) {
  const box = clear($('batchStats'));
  if (!res || !res.ok) {
    box.append(h('div', { class: 'error-box' }, (res && res.error) || '批量请求失败'));
    return;
  }
  box.append(h('div', { class: 'batch-cards' },
    batchCard('总请求数', res.total),
    batchCard('成功', res.success, res.failed ? 'ok' : ''),
    batchCard('失败', res.failed, res.failed ? 'err' : ''),
    batchCard('RPS', res.rps.toFixed(1)),
    batchCard('总耗时', `${res.durationMs} ms`)));

  if (res.timeStats) {
    const t = res.timeStats;
    box.append(h('h4', { class: 'batch-h4' }, '成功请求耗时（2xx/3xx）'));
    box.append(h('table', { class: 'diff-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'min'), h('th', {}, 'avg'), h('th', {}, 'P50'), h('th', {}, 'P90'), h('th', {}, 'P95'), h('th', {}, 'P99'), h('th', {}, 'max'))),
      h('tbody', {}, h('tr', {}, [t.min, t.avg, t.p50, t.p90, t.p95, t.p99, t.max]
        .map((v) => h('td', { class: 'diff-val' }, `${v} ms`))))));
  }

  box.append(h('h4', { class: 'batch-h4' }, '状态分布'));
  const dist = h('div', { class: 'batch-dist' });
  const entries = Object.entries(res.statusDist).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) dist.append(h('span', { class: 'muted' }, '无'));
  for (const [k, v] of entries) {
    const cls = k === 'ERR' ? 'removed' : k.startsWith('2') ? 'added' : 'changed';
    dist.append(h('span', { class: `chip ${cls}` }, `${k} × ${v}`));
  }
  box.append(dist);

  const errEntries = Object.entries(res.errors);
  if (errEntries.length > 0) {
    box.append(h('h4', { class: 'batch-h4' }, '错误聚合'));
    for (const [msg, n] of errEntries.slice(0, 20)) {
      box.append(h('div', { class: 'log-line error' }, `${msg}（${n} 次）`));
    }
  }

  if (res.sample) {
    box.append(h('h4', { class: 'batch-h4' }, `样本响应（第 1 份成功响应，${res.sample.status}，${res.sample.timeMs} ms${res.sample.truncated ? '，已达上限' : ''}）`));
    box.append(h('pre', { class: 'raw' }, bytesToText(base64ToBytes(res.sample.bodyBase64))));
  } else {
    box.append(h('div', { class: 'pretty-note' }, '无样本响应（无 2xx/3xx 响应）'));
  }

  box.append(h('h4', { class: 'batch-h4' }, '请求明细'));
  const table = h('table', { class: 'diff-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, '#'), h('th', {}, '状态'), h('th', {}, '耗时'), h('th', {}, '大小'), h('th', {}, '错误'))));
  const tbody = h('tbody');
  for (const r of res.results.slice(0, 200)) {
    tbody.append(h('tr', { class: r.error ? 'diff-row removed' : 'diff-row added' },
      h('td', { class: 'diff-val' }, String(r.index + 1)),
      h('td', { class: 'diff-val' }, String(r.status || 'ERR')),
      h('td', { class: 'diff-val' }, `${r.timeMs} ms`),
      h('td', { class: 'diff-val' }, `${formatSize(r.sizeBytes || 0)}${r.truncated ? '（已达上限）' : ''}`),
      h('td', { class: 'diff-val' }, r.error || '')));
  }
  table.append(tbody);
  box.append(table);
  if (res.results.length > 200) {
    box.append(h('div', { class: 'muted' }, `仅显示前 200 条（共 ${res.results.length} 条）`));
  }
}

async function quitApp() {
  if (!confirm(abortController ? '请求仍在运行，确定取消并退出 HTTP Test 吗？' : '确定要退出 HTTP Test 吗？')) return false;
  closeConfirmed = true;
  flushDraft();
  try {
    await exitApp();
    return true;
  } catch (e) {
    closeConfirmed = false;
    toast(`退出失败：${e.message}`, 'error');
    return false;
  }
}

function bindWindowClose() {
  const bridge = window.__TAURI__;
  if (!bridge || !bridge.window || typeof bridge.window.getCurrentWindow !== 'function') return;
  const currentWindow = bridge.window.getCurrentWindow();
  if (!currentWindow || typeof currentWindow.onCloseRequested !== 'function') return;
  currentWindow.onCloseRequested(async (event) => {
    if (closeConfirmed) return;
    event.preventDefault();
    await quitApp();
  });
}

function bindEvents() {
  $('method').addEventListener('change', (e) => {
    state.method = e.target.value;
    saveDraft();
  });
  $('url').addEventListener('input', (e) => {
    state.url = e.target.value;
    syncUrlToParams();
    saveDraft();
  });
  $('timeout').addEventListener('input', (e) => {
    state.timeoutMs = Math.max(0, Number(e.target.value) || 0);
    saveDraft();
  });
  $('followRedirects').addEventListener('change', (e) => {
    state.followRedirects = e.target.checked;
    saveDraft();
  });
  $('insecure').addEventListener('change', (e) => {
    state.insecure = e.target.checked;
    saveDraft();
  });
  $('bodyType').addEventListener('change', (e) => {
    const next = e.target.value;
    const prev = state.bodyType;
    if ((next === 'form' || next === 'urlencoded') && prev === 'json' && state.body.trim()) {
      try {
        state.formFields = jsonToFields(state.body);
        state.body = '';
        $('bodyText').value = '';
        formEditor.setRows(state.formFields, true);
        toast('已自动将 JSON 转换为表单参数', 'ok');
      } catch {
        /* JSON 不合法则保留原表单 */
      }
    }
    if (next === 'json' && (prev === 'form' || prev === 'urlencoded') && !state.body.trim() && state.formFields.length > 0) {
      state.body = fieldsToJson(state.formFields);
      $('bodyText').value = state.body;
      toast('已自动将表单参数转换为 JSON（值均为字符串）', 'ok');
    }
    state.bodyType = next;
    updateBodyUI();
    saveDraft();
  });
  $('bodyText').addEventListener('input', (e) => {
    state.body = e.target.value;
    saveDraft();
  });
  $('preScript').addEventListener('input', (e) => {
    state.preScript = e.target.value;
    saveDraft();
  });
  $('postScript').addEventListener('input', (e) => {
    state.postScript = e.target.value;
    saveDraft();
  });
  $('fileLimit').addEventListener('change', (e) => {
    state.fileLimitMb = clampFileLimit(e.target.value);
    e.target.value = state.fileLimitMb;
    updateBodyUI();
    saveDraft();
  });
  $('binaryFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > fileLimitBytes()) {
      toast(uploadLimitError(file.size), 'error');
      return;
    }
    if (file.size > MAX_BINARY_FILE_BYTES) {
      toast(`单个文件不能超过 ${formatSize(MAX_BINARY_FILE_BYTES)}`, 'error');
      return;
    }
    const version = ++binaryReadVersion;
    const reader = new FileReader();
    reader.onload = () => {
      if (version !== binaryReadVersion) return;
      const dataUrl = String(reader.result);
      state.binary = {
        fileName: file.name,
        fileSize: file.size,
        contentType: file.type || 'application/octet-stream',
        base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      };
      updateBodyUI();
      saveDraft();
    };
    reader.onerror = () => toast(`文件读取失败: ${file.name}`, 'error');
    reader.readAsDataURL(file);
  });

  $('btnFormat').addEventListener('click', () => {
    try {
      state.body = formatJson(state.body);
      $('bodyText').value = state.body;
      saveDraft();
      toast('已无损格式化（大整数保持原样）', 'ok');
    } catch (e) {
      toast(`格式化失败: ${e.message}`, 'error');
    }
  });
  const convertBody = (target) => {
    try {
      state.formFields = jsonToFields(state.body);
      formEditor.setRows(state.formFields, true);
      state.body = '';
      $('bodyText').value = '';
      state.bodyType = target;
      $('bodyType').value = target;
      updateBodyUI();
      saveDraft();
      toast(`已转换为 ${target === 'form' ? 'form-data' : 'urlencoded'} 参数`, 'ok');
    } catch (e) {
      toast(`转换失败: ${e.message}`, 'error');
    }
  };
  $('btnToForm').addEventListener('click', () => convertBody('form'));
  $('btnToUrlencoded').addEventListener('click', () => convertBody('urlencoded'));
  $('btnToJson').addEventListener('click', () => {
    state.body = fieldsToJson(state.formFields);
    $('bodyText').value = state.body;
    state.bodyType = 'json';
    $('bodyType').value = 'json';
    updateBodyUI();
    saveDraft();
    toast('已转换为 JSON（值均为字符串）', 'ok');
  });

  $('btnSend').addEventListener('click', doSend);
  $('btnBatch').addEventListener('click', () => openDrawer('batchDrawer'));
  $('closeBatch').addEventListener('click', closeDrawers);
  $('btnBatchStart').addEventListener('click', doBatch);
  $('btnBatchCancel').addEventListener('click', () => {
    if (abortController) abortController.abort();
  });
  const updateBatchHint = () => {
    const c = Math.floor(Number($('batchCount').value)) || 0;
    const r = Math.floor(Number($('batchRounds').value)) || 0;
    const total = c * r;
    $('batchTotal').textContent = `总请求数：${total}${total > 1000 ? '（超上限 1000，无法开始）' : `（${c}×${r}）`}`;
  };
  $('batchCount').addEventListener('input', updateBatchHint);
  $('batchRounds').addEventListener('input', updateBatchHint);
  $('btnCancel').addEventListener('click', () => {
    if (abortController) abortController.abort();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!$('curlDrawer').hidden) importCurl();
      else doSend();
    }
  });

  $('showTypes').addEventListener('change', rerenderPretty);
  $('btnExpandAll').addEventListener('click', () => {
    expandDepth = Infinity;
    rerenderPretty();
  });
  $('btnCollapseAll').addEventListener('click', () => {
    expandDepth = 0;
    rerenderPretty();
  });
  $('btnCopyResp').addEventListener('click', () => {
    if (lastResponse && lastResponse.ok) copyText(lastResponse.bodyText);
    else toast('暂无响应', 'error');
  });

  $('btnDiff').addEventListener('click', runDiff);
  $('btnDiffLast').addEventListener('click', () => {
    const usable = history.filter((e) => e.bodyText !== null);
    if (usable.length < 2) {
      toast('至少需要两条保留原文的历史响应', 'error');
      return;
    }
    $('diffA').value = usable[1].id;
    $('diffB').value = usable[0].id;
    runDiff();
  });

  $('btnVars').addEventListener('click', () => openDrawer('varsDrawer'));
  $('btnHistory').addEventListener('click', () => openDrawer('historyDrawer'));
  $('btnCurl').addEventListener('click', () => {
    $('curlMessage').textContent = '';
    $('curlMessage').classList.remove('error');
    openDrawer('curlDrawer');
    $('curlText').focus();
  });
  $('btnCurlImport').addEventListener('click', importCurl);
  $('closeCurl').addEventListener('click', () => {
    closeDrawers();
    $('btnCurl').focus();
  });
  $('btnStop').addEventListener('click', () => quitApp());
  $('closeVars').addEventListener('click', closeDrawers);
  $('closeHistory').addEventListener('click', closeDrawers);
  $('drawerMask').addEventListener('click', closeDrawers);

  $('btnExportVars').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(vars, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: 'httpt-vars.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('btnImportVars').addEventListener('click', () => $('importVarsFile').click());
  $('importVarsFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const list = JSON.parse(String(reader.result));
        if (!Array.isArray(list)) throw new Error('需要 JSON 数组');
        vars = list.map((v) => ({
          key: String(v.key || ''),
          value: String(v.value || ''),
          enabled: v.enabled !== false,
        }));
        const saved = saveVars(vars);
        varsEditor.setRows(vars, true);
        updateCounts();
        toast(
          saved ? `已导入 ${vars.length} 个变量` : `已导入 ${vars.length} 个变量，但应用存储空间已满，未能持久化`,
          saved ? 'ok' : 'error'
        );
      } catch (err) {
        toast(`导入失败: ${err.message}`, 'error');
      }
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  });

  $('btnClearHistory').addEventListener('click', () => {
    history = [];
    const saved = persistHistory();
    renderHistory();
    refreshDiffSelects();
    updateCounts();
    toast(saved ? '历史已清空' : '历史已从内存清空，但存储清理失败', saved ? 'ok' : 'error');
  });
}

wireTabs('reqTabs');
wireTabs('respTabs');
bindEvents();
bindWindowClose();
loadDraft();
applyRequestToUI();
varsEditor.setRows(vars, true);
renderHistory();
refreshDiffSelects();
updateCounts();
renderLogs();