import { h, clear } from './dom.js';
import { parse } from './losslessJson.js';
import { diffValues, KIND_LABEL } from './diff.js';

export function renderDiff(container, textA, textB) {
  clear(container);
  let a;
  let b;
  try {
    a = parse(textA);
  } catch (e) {
    container.append(h('div', { class: 'diff-error' }, `响应 A 不是合法 JSON：${e.message}`));
    return;
  }
  try {
    b = parse(textB);
  } catch (e) {
    container.append(h('div', { class: 'diff-error' }, `响应 B 不是合法 JSON：${e.message}`));
    return;
  }

  const { rows, counts } = diffValues(a, b);
  const summary = h('div', { class: 'diff-summary' },
    h('span', { class: 'chip added' }, `新增 ${counts.added}`),
    h('span', { class: 'chip removed' }, `删除 ${counts.removed}`),
    h('span', { class: 'chip changed' }, `值变更 ${counts.changed}`),
    h('span', { class: 'chip type' }, `类型变更 ${counts.type}`));
  container.append(summary);

  if (rows.length === 0) {
    container.append(h('div', { class: 'diff-empty' }, '两份响应结构完全一致（数字按原始文本精确比较）'));
    return;
  }

  const table = h('table', { class: 'diff-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, '路径'),
      h('th', {}, '变化'),
      h('th', {}, 'A 类型'),
      h('th', {}, 'B 类型'),
      h('th', {}, 'A 值'),
      h('th', {}, 'B 值'))));
  const tbody = h('tbody');
  for (const r of rows.slice(0, 2000)) {
    tbody.append(h('tr', { class: `diff-row ${r.kind}` },
      h('td', { class: 'diff-path' }, r.path),
      h('td', {}, h('span', { class: `chip ${r.kind}` }, KIND_LABEL[r.kind])),
      h('td', { class: `t-${r.leftType}` }, r.leftType),
      h('td', { class: `t-${r.rightType}` }, r.rightType),
      h('td', { class: 'diff-val' }, r.left),
      h('td', { class: 'diff-val' }, r.right)));
  }
  table.append(tbody);
  container.append(table);
  if (rows.length > 2000) {
    container.append(h('div', { class: 'muted' }, `差异过多，仅显示前 2000 条（共 ${rows.length} 条）`));
  }
}