const STORAGE_KEY = 'httpt.vars';

export function loadVars() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveVars(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    // 配额不足：调用方需自行提示，内存中的变量仍可用
    return false;
  }
}

export function varMap(list) {
  const map = new Map();
  for (const v of list) {
    if (v.enabled !== false && v.key) map.set(v.key, String(v.value || ''));
  }
  return map;
}

export function substitute(text, map, unresolved) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, name) => {
    if (map.has(name)) return map.get(name);
    if (unresolved) unresolved.add(name);
    return m;
  });
}

export function applyVars(req, list) {
  const map = varMap(list);
  const unresolved = new Set();
  const out = {
    ...req,
    url: substitute(req.url, map, unresolved),
    body: substitute(req.body, map, unresolved),
    headers: req.headers.map((h) => ({
      ...h,
      key: substitute(h.key, map, unresolved),
      value: substitute(h.value, map, unresolved),
    })),
    query: req.query.map((q) => ({
      ...q,
      key: substitute(q.key, map, unresolved),
      value: substitute(q.value, map, unresolved),
    })),
    formFields: req.formFields.map((f) =>
      f.kind === 'file'
        ? { ...f, key: substitute(f.key, map, unresolved) }
        : { ...f, key: substitute(f.key, map, unresolved), value: substitute(f.value, map, unresolved) }
    ),
  };
  return { req: out, unresolved: [...unresolved] };
}

export function makeVarsApi(getList, onChange) {
  return {
    get(key) {
      const v = getList().find((x) => x.key === key && x.enabled !== false);
      return v ? String(v.value || '') : undefined;
    },
    set(key, value) {
      const list = getList();
      const item = list.find((x) => x.key === key);
      if (item) item.value = String(value);
      else list.push({ key, value: String(value), enabled: true });
      // 持久化失败不应中断脚本，仅告警
      if (!saveVars(list)) {
        console.warn('变量持久化失败：应用存储空间已满', key);
      }
      onChange();
    },
    remove(key) {
      const list = getList();
      const i = list.findIndex((x) => x.key === key);
      if (i >= 0) {
        list.splice(i, 1);
        if (!saveVars(list)) {
          console.warn('变量持久化失败：应用存储空间已满', key);
        }
        onChange();
      }
    },
    all() {
      const obj = {};
      for (const [k, v] of varMap(getList())) obj[k] = v;
      return obj;
    },
  };
}