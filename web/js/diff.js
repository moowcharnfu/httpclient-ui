import { typeOf, preview, isLosslessNumber } from './losslessJson.js';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function keyPath(path, k) {
  return /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`;
}

function scalarText(v) {
  return isLosslessNumber(v) ? v.raw : String(v);
}

function walk(a, b, path, rows) {
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) {
    rows.push({ path, kind: 'type', leftType: ta, rightType: tb, left: preview(a), right: preview(b) });
    return;
  }
  if (ta === 'object') {
    const keys = Object.keys(a);
    for (const k of Object.keys(b)) if (!hasOwn(a, k)) keys.push(k);
    for (const k of keys) {
      const p = keyPath(path, k);
      if (!hasOwn(a, k)) {
        rows.push({ path: p, kind: 'added', leftType: '-', rightType: typeOf(b[k]), left: '', right: preview(b[k]) });
      } else if (!hasOwn(b, k)) {
        rows.push({ path: p, kind: 'removed', leftType: typeOf(a[k]), rightType: '-', left: preview(a[k]), right: '' });
      } else {
        walk(a[k], b[k], p, rows);
      }
    }
    return;
  }
  if (ta === 'array') {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}[${i}]`;
      if (i >= a.length) {
        rows.push({ path: p, kind: 'added', leftType: '-', rightType: typeOf(b[i]), left: '', right: preview(b[i]) });
      } else if (i >= b.length) {
        rows.push({ path: p, kind: 'removed', leftType: typeOf(a[i]), rightType: '-', left: preview(a[i]), right: '' });
      } else {
        walk(a[i], b[i], p, rows);
      }
    }
    return;
  }
  if (scalarText(a) !== scalarText(b)) {
    rows.push({ path, kind: 'changed', leftType: ta, rightType: tb, left: preview(a), right: preview(b) });
  }
}

export function diffValues(a, b) {
  const rows = [];
  walk(a, b, '$', rows);
  const counts = { added: 0, removed: 0, changed: 0, type: 0 };
  for (const r of rows) counts[r.kind]++;
  return { rows, counts };
}

export const KIND_LABEL = {
  added: '新增',
  removed: '删除',
  changed: '值变更',
  type: '类型变更',
};