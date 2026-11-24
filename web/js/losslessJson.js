const MAX_DEPTH = 512;
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export class LosslessNumber {
  constructor(raw) {
    this.raw = raw;
  }
  toString() {
    return this.raw;
  }
  toJSON() {
    return this.raw;
  }
  toNumber() {
    return Number(this.raw);
  }
  isInteger() {
    return /^-?\d+$/.test(this.raw);
  }
  isUnsafeInteger() {
    // 2^53-1 = 9007199254740991；|x| > 该值为不安全。纯字符串比较，不依赖 BigInt（Safari 14+ 才有）
    // 指数形式（如 1e21）同样判定：值 = intPart.fracPart × 10^exp，小数点右移 exp 位后看整数部分
    const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(this.raw);
    if (!m) return false;
    const digits = m[2] + (m[3] || '');
    const pointPos = m[2].length + Number(m[4] || '0');
    if (pointPos < 0) return false;
    let whole;
    if (pointPos > digits.length) {
      // 补零超过 16 位必然超出安全整数范围，避免为超大指数分配大字符串
      if (pointPos - digits.length > 16) return true;
      whole = digits + '0'.repeat(pointPos - digits.length);
    } else {
      if (/[^0]/.test(digits.slice(pointPos))) return false;
      whole = digits.slice(0, pointPos);
    }
    const trimmed = whole.replace(/^0+/, '') || '0';
    if (trimmed === '0') return false;
    return trimmed.length > 16 || (trimmed.length === 16 && trimmed > '9007199254740991');
  }
}

export function isLosslessNumber(v) {
  return v instanceof LosslessNumber;
}

export function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (isLosslessNumber(v)) return 'number';
  return typeof v;
}

export function parse(text) {
  let pos = 0;
  const len = text.length;

  function fail(msg) {
    const line = text.slice(0, pos).split('\n').length;
    throw new SyntaxError(`${msg}（位置 ${pos}，第 ${line} 行）`);
  }
  function ws() {
    while (pos < len) {
      const c = text[pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') pos++;
      else break;
    }
  }
  function peek() {
    return pos < len ? text[pos] : '';
  }
  function expect(c) {
    if (peek() !== c) fail(`期望 '${c}'`);
    pos++;
  }
  function parseString() {
    expect('"');
    let out = '';
    while (pos < len) {
      const c = text[pos++];
      if (c === '"') return out;
      if (c === '\\') {
        const e = text[pos++];
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = text.slice(pos, pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('非法 \\u 转义');
            pos += 4;
            out += String.fromCharCode(parseInt(hex, 16));
            break;
          }
          default: fail(`非法转义 \\${e}`);
        }
      } else if (c.charCodeAt(0) < 0x20) {
        fail('字符串中存在未转义控制字符');
      } else {
        out += c;
      }
    }
    fail('字符串未闭合');
  }
  function parseNumber() {
    const start = pos;
    if (peek() === '-') pos++;
    while (pos < len && text[pos] >= '0' && text[pos] <= '9') pos++;
    if (peek() === '.') {
      pos++;
      while (pos < len && text[pos] >= '0' && text[pos] <= '9') pos++;
    }
    if (peek() === 'e' || peek() === 'E') {
      pos++;
      if (peek() === '+' || peek() === '-') pos++;
      while (pos < len && text[pos] >= '0' && text[pos] <= '9') pos++;
    }
    const raw = text.slice(start, pos);
    if (!NUMBER_RE.test(raw)) fail(`非法数字 '${raw}'`);
    return new LosslessNumber(raw);
  }
  function parseValue(depth) {
    if (depth > MAX_DEPTH) fail(`嵌套深度超过 ${MAX_DEPTH}`);
    ws();
    const c = peek();
    if (c === '{') return parseObject(depth + 1);
    if (c === '[') return parseArray(depth + 1);
    if (c === '"') return parseString();
    if (c === 't') {
      if (text.slice(pos, pos + 4) !== 'true') fail('非法字面量');
      pos += 4;
      return true;
    }
    if (c === 'f') {
      if (text.slice(pos, pos + 5) !== 'false') fail('非法字面量');
      pos += 5;
      return false;
    }
    if (c === 'n') {
      if (text.slice(pos, pos + 4) !== 'null') fail('非法字面量');
      pos += 4;
      return null;
    }
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    fail(`意外字符 '${c}'`);
  }
  function parseObject(depth) {
    expect('{');
    const obj = {};
    ws();
    if (peek() === '}') {
      pos++;
      return obj;
    }
    while (true) {
      ws();
      const key = parseString();
      ws();
      expect(':');
      const value = parseValue(depth);
      if (key === '__proto__') {
        Object.defineProperty(obj, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else {
        obj[key] = value;
      }
      ws();
      const c = peek();
      if (c === ',') {
        pos++;
        continue;
      }
      if (c === '}') {
        pos++;
        return obj;
      }
      fail("期望 ',' 或 '}'");
    }
  }
  function parseArray(depth) {
    expect('[');
    const arr = [];
    ws();
    if (peek() === ']') {
      pos++;
      return arr;
    }
    while (true) {
      arr.push(parseValue(depth));
      ws();
      const c = peek();
      if (c === ',') {
        pos++;
        continue;
      }
      if (c === ']') {
        pos++;
        return arr;
      }
      fail("期望 ',' 或 ']'");
    }
  }

  const value = parseValue(0);
  ws();
  if (pos !== len) fail('JSON 末尾存在多余内容');
  return value;
}

export function stringify(value, indent = 0, level = 0) {
  const pad = indent > 0 ? ' '.repeat(indent * (level + 1)) : '';
  const padEnd = indent > 0 ? ' '.repeat(indent * level) : '';
  const nl = indent > 0 ? '\n' : '';
  const sep = indent > 0 ? ': ' : ':';

  if (value === null) return 'null';
  if (isLosslessNumber(value)) return value.raw;
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('无法序列化非有限数字');
    return String(value);
  }
  if (t === 'boolean') return String(value);
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => pad + stringify(v, indent, level + 1));
    return '[' + nl + items.join(',' + nl) + nl + padEnd + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const items = keys.map(
      (k) => pad + JSON.stringify(k) + sep + stringify(value[k], indent, level + 1)
    );
    return '{' + nl + items.join(',' + nl) + nl + padEnd + '}';
  }
  throw new TypeError(`无法序列化类型 ${t}`);
}

export function preview(value, max = 80) {
  const t = typeOf(value);
  let s;
  if (t === 'number') s = value.raw;
  else if (t === 'string') s = JSON.stringify(value);
  else if (t === 'object') s = `{…} ${Object.keys(value).length} 键`;
  else if (t === 'array') s = `[…] ${value.length} 项`;
  else s = String(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}