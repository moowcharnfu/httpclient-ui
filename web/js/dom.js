export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'class') {
      el.className = v;
    } else if (k === 'dataset') {
      Object.assign(el.dataset, v);
    } else if (k in el && k !== 'list' && typeof v !== 'string') {
      el[k] = v;
    } else {
      el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

let toastTimer = null;
export function toast(msg, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast' });
    document.body.append(el);
  }
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = '';
  }, 3000);
}

function fallbackCopy(text) {
  const ta = h('textarea', { value: text, style: 'position:fixed;opacity:0' });
  document.body.append(ta);
  ta.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  ta.remove();
  if (!copied) {
    toast('复制失败，请手动选择文本', 'error');
    return Promise.resolve();
  }
  toast('已复制', 'ok');
  return Promise.resolve();
}

export function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text)
      .then(() => toast('已复制', 'ok'))
      .catch(() => fallbackCopy(text));
  }
  return fallbackCopy(text);
}