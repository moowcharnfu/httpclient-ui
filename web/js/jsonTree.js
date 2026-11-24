import { h, clear, copyText } from './dom.js';
import { typeOf, isLosslessNumber } from './losslessJson.js';

const PAGE = 300;
const RENDER_BUDGET = 200000;

export function renderJsonTree(container, root, opts = {}) {
  const { showTypes = false, expandDepth = 2 } = opts;
  clear(container);
  const wrap = h('div', { class: 'json-tree' });
  let budget = RENDER_BUDGET;
  wrap.append(buildNode(root, '$', 0, null));
  container.append(wrap);

  function typeBadge(v) {
    if (!showTypes) return null;
    return h('span', { class: `type-badge t-${typeOf(v)}` }, typeOf(v));
  }

  function leafRow(keyLabel, path, value) {
    const t = typeOf(value);
    const valueEl = h('span', { class: `jv jv-${t}` });
    if (t === 'number') {
      valueEl.textContent = value.raw;
      if (value.isUnsafeInteger()) {
        valueEl.append(h('span', { class: 'long-badge', title: '超出 JS 安全整数范围，此处按原始文本精确展示' }, 'long'));
      }
    } else if (t === 'string') {
      valueEl.textContent = JSON.stringify(value);
    } else {
      valueEl.textContent = String(value);
    }
    return h('div', { class: 'json-row' },
      h('span', { class: 'jt-toggle leaf' }, '·'),
      keyLabel ? h('span', { class: 'jk', title: '点击复制路径', onClick: () => copyText(path) }, keyLabel, ': ') : null,
      valueEl,
      typeBadge(value));
  }

  function buildNode(value, path, depth, keyLabel) {
    const t = typeOf(value);
    if (t !== 'object' && t !== 'array') {
      return leafRow(keyLabel, path, value);
    }
    const entries = t === 'array'
      ? value.map((v, i) => [String(i), v, `${path}[${i}]`])
      : Object.keys(value).map((k) => [k, value[k], /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`]);

    const open = t === 'array' ? '[' : '{';
    const close = t === 'array' ? ']' : '}';
    const expanded = depth < expandDepth;
    const childrenBox = h('div', { class: 'json-children' });
    let rendered = 0;

    const toggle = h('span', { class: 'jt-toggle' }, expanded ? '▼' : '▶');
    const summary = h('span', { class: 'jsummary muted' }, ` ${open}…${close} ${entries.length} ${t === 'array' ? '项' : '键'}`);
    const row = h('div', { class: 'json-row' },
      toggle,
      keyLabel ? h('span', { class: 'jk', title: '点击复制路径', onClick: () => copyText(path) }, keyLabel, ': ') : null,
      h('span', { class: 'jv jv-bracket' }, open),
      summary,
      typeBadge(value));

    const limitNotice = h('span', { class: 'muted' }, `已达渲染上限（${RENDER_BUDGET} 节点），折叠部分层级后可继续查看`);

    function renderMore() {
      const end = Math.min(rendered + PAGE, entries.length);
      for (; rendered < end && budget > 0; rendered++) {
        budget--;
        const [k, v, p] = entries[rendered];
        childrenBox.append(buildNode(v, p, depth + 1, k));
      }
      moreBtn.remove();
      limitNotice.remove();
      if (rendered < entries.length) {
        if (budget <= 0) {
          childrenBox.append(limitNotice);
        } else {
          childrenBox.append(moreBtn);
        }
      }
    }

    const moreBtn = h('button', {
      class: 'mini',
      onClick: (e) => {
        e.stopPropagation();
        renderMore();
      },
    }, `再显示 ${Math.min(PAGE, entries.length)} 项…`);

    if (expanded) {
      renderMore();
      summary.style.display = 'none';
    } else {
      childrenBox.style.display = 'none';
    }

    const closeRow = h('div', { class: 'json-row json-close' }, h('span', { class: 'jt-toggle leaf' }, ''), h('span', { class: 'jv jv-bracket' }, close));
    closeRow.style.display = expanded ? '' : 'none';

    let loaded = expanded;
    toggle.parentElement.addEventListener('click', (e) => {
      if (e.target.classList.contains('jk')) return;
      const nowOpen = childrenBox.style.display === 'none';
      if (nowOpen && !loaded) {
        renderMore();
        loaded = true;
      }
      childrenBox.style.display = nowOpen ? '' : 'none';
      closeRow.style.display = nowOpen ? '' : 'none';
      summary.style.display = nowOpen ? 'none' : '';
      toggle.textContent = nowOpen ? '▼' : '▶';
    });

    return h('div', { class: 'json-node' }, row, childrenBox, closeRow);
  }
}

export function treeStats(root) {
  let longs = 0;
  let nodes = 0;
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    nodes++;
    if (isLosslessNumber(v)) {
      if (v.isUnsafeInteger()) longs++;
    } else if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) stack.push(x);
    }
    if (nodes > 200000) break;
  }
  return { longs, nodes };
}