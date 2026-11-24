import { stringify, isLosslessNumber } from './losslessJson.js';

export const MAX_SCRIPT_LOG_LINES = 2000;

function fmtArg(a) {
  if (typeof a === 'string') return a;
  if (isLosslessNumber(a)) return a.raw;
  if (a instanceof Error) return a.stack || a.message;
  try {
    return stringify(a);
  } catch {
    return String(a);
  }
}

function makeConsole(logs, stats) {
  const push = (level) => (...args) => {
    if (logs.length >= MAX_SCRIPT_LOG_LINES) {
      stats.dropped += 1;
      return;
    }
    logs.push({ level, text: args.map(fmtArg).join(' '), ts: Date.now() });
  };
  return { log: push('log'), info: push('log'), warn: push('warn'), error: push('error') };
}

export function runPre(code, req, varsApi) {
  const logs = [];
  const stats = { dropped: 0 };
  if (!code || !code.trim()) return { logs, dropped: 0 };
  try {
    // 函数体仅包含用户本人编写的脚本；外部数据一律经参数传入，不拼接进代码字符串
    const fn = new Function('req', 'vars', 'console', '"use strict";\n' + code);
    fn(req, varsApi, makeConsole(logs, stats));
  } catch (e) {
    return { logs, dropped: stats.dropped, error: e };
  }
  return { logs, dropped: stats.dropped };
}

export function runPost(code, res, varsApi) {
  const logs = [];
  const stats = { dropped: 0 };
  if (!code || !code.trim()) return { logs, dropped: 0 };
  try {
    const fn = new Function('res', 'vars', 'console', '"use strict";\n' + code);
    fn(res, varsApi, makeConsole(logs, stats));
  } catch (e) {
    return { logs, dropped: stats.dropped, error: e };
  }
  return { logs, dropped: stats.dropped };
}