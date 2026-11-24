import { parse, stringify, isLosslessNumber, typeOf } from './losslessJson.js';

export function splitUrl(url) {
  const hashIdx = url.indexOf('#');
  const hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
  const noHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const qIdx = noHash.indexOf('?');
  const base = qIdx >= 0 ? noHash.slice(0, qIdx) : noHash;
  const queryStr = qIdx >= 0 ? noHash.slice(qIdx + 1) : '';
  const pairs = [];
  if (queryStr) {
    for (const part of queryStr.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const k = eq >= 0 ? part.slice(0, eq) : part;
      const v = eq >= 0 ? part.slice(eq + 1) : '';
      pairs.push({ key: safeDecode(k), value: safeDecode(v), enabled: true });
    }
  }
  return { base, pairs, hash };
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

export function joinUrl(base, pairs, hash = '') {
  const active = pairs.filter((p) => p.enabled !== false && p.key !== '');
  if (active.length === 0) return base + hash;
  const qs = active
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value || '')}`)
    .join('&');
  return `${base}?${qs}${hash}`;
}

export function formatJson(text) {
  return stringify(parse(text), 2);
}

export function jsonToFields(text) {
  const value = parse(text);
  if (typeOf(value) !== 'object') throw new Error('仅 JSON 对象可转换为表单参数');
  return Object.entries(value).map(([key, v]) => {
    const t = typeOf(v);
    let str;
    if (t === 'string') str = v;
    else if (t === 'number') str = v.raw;
    else if (t === 'object' || t === 'array') str = stringify(v);
    else str = String(v);
    return { key, value: str, kind: 'text', enabled: true };
  });
}

export function fieldsToJson(fields) {
  const obj = {};
  for (const f of fields) {
    if (f.enabled === false || !f.key || f.kind === 'file') continue;
    obj[f.key] = f.value || '';
  }
  return stringify(obj, 2);
}

export function isLossless(v) {
  return isLosslessNumber(v);
}