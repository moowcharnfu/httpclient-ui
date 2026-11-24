import { splitUrl, joinUrl } from './convert.js';

const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_TOKENS = 4096;
const MAX_QUERY_PARAMS = 4096;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const VALUE_ALIASES = new Map([
  ['X', 'request'], ['H', 'header'], ['u', 'user'], ['d', 'data-raw'],
  ['A', 'user-agent'], ['e', 'referer'], ['b', 'cookie'],
]);
const FILE_OPTIONS = new Map([
  ['form', '-F/--form 涉及文件或 multipart，请在导入后于 Body 区手动配置'],
  ['form-string', '-F/--form 涉及文件或 multipart，请在导入后于 Body 区手动配置'],
  ['upload-file', '-T/--upload-file 需要读取本地文件，请改用 binary 上传'],
  ['output', '-o/--output 会写入本地文件，应用不支持'],
  ['dump-header', '-D/--dump-header 会写入本地文件，应用不支持'],
  ['cookie-jar', '-c/--cookie-jar 会写入本地文件，应用不支持'],
  ['config', '-K/--config 会读取其他文件，应用不支持'],
  ['cacert', '自定义 CA 证书文件暂不支持'],
  ['cert', '客户端证书文件暂不支持'],
  ['key', '客户端证书密钥文件暂不支持'],
]);
const SHORT_FILE_OPTIONS = new Map([
  ['F', FILE_OPTIONS.get('form')],
  ['T', FILE_OPTIONS.get('upload-file')],
  ['o', FILE_OPTIONS.get('output')],
  ['D', FILE_OPTIONS.get('dump-header')],
  ['c', FILE_OPTIONS.get('cookie-jar')],
  ['K', FILE_OPTIONS.get('config')],
]);

function fail(message) {
  throw new Error(message);
}

function tokenize(command) {
  const tokens = [];
  let token = '';
  let quote = '';
  let started = false;
  let i = 0;
  const push = () => {
    if (started) tokens.push(token);
    if (tokens.length > MAX_TOKENS) fail(`cURL 参数过多（上限 ${MAX_TOKENS}）`);
    token = '';
    started = false;
  };

  while (i < command.length) {
    const ch = command[i];
    if (quote !== "'" && ch === '\\') {
      const next = command[i + 1];
      if (next === '\n') {
        i += 2;
        continue;
      }
      if (next === '\r' && command[i + 2] === '\n') {
        i += 3;
        continue;
      }
      if (next === undefined) fail('cURL 末尾存在未完成的转义');
      if (quote === '"' && !['"', '\\', '$', '`'].includes(next)) {
        token += '\\';
        i += 1;
        continue;
      }
      token += next;
      started = true;
      i += 2;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = '';
      else token += ch;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = '';
      else {
        if (ch === '$' && command[i + 1] === '(') {
          fail('不支持 Shell 命令替换 $(...)；请改用单引号包含字面量');
        }
        if (ch === '`') fail('不支持 Shell 命令替换；请改用单引号包含字面量');
        token += ch;
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      i += 1;
      continue;
    }
    if (quote !== "'" && ch === '$' && command[i + 1] === '(') {
      fail('不支持 Shell 命令替换 $(...)；请改用单引号包含字面量');
    }
    if (quote !== "'" && ch === '`') {
      fail('不支持 Shell 命令替换；请改用单引号包含字面量');
    }
    if (!quote && ';|&<>()'.includes(ch)) {
      fail(`不支持 Shell 操作符 ${ch}；请将参数放入引号`);
    }
    if (!quote && /\s/.test(ch)) {
      push();
      i += 1;
      continue;
    }
    token += ch;
    started = true;
    i += 1;
  }
  if (quote) fail('cURL 存在未闭合的引号');
  push();
  return tokens;
}

function encodeComponent(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodeDataUrlencode(value) {
  const eq = value.indexOf('=');
  const fileValue = value.startsWith('@')
    || (eq < 0 && !value.startsWith('+') && value.includes('@'))
    || (eq >= 0 && value.slice(eq + 1).startsWith('@'));
  if (fileValue) fail('--data-urlencode 的 @file 需要读取本地文件，请手动配置');
  if (value.startsWith('+')) return encodeComponent(value.slice(1));
  if (eq === 0) return encodeComponent(value.slice(1));
  if (eq > 0) return `${encodeComponent(value.slice(0, eq))}=${encodeComponent(value.slice(eq + 1))}`;
  return encodeComponent(value);
}

function basicAuth(value) {
  const colon = value.indexOf(':');
  if (colon < 0) fail('-u/--user 需写成 用户名:密码；不交互获取密码');
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return `Basic ${btoa(binary)}`;
}

function parseHeader(value) {
  if (value.startsWith('@')) fail('-H/--header 的 @file 需要读取本地文件，请手动填写 Header');
  const colon = value.indexOf(':');
  if (colon < 0) fail(`Header 缺少冒号: ${value}`);
  const key = value.slice(0, colon).trim();
  const headerValue = value.slice(colon + 1).trim();
  if (!HEADER_NAME.test(key)) fail(`Header 名非法: ${key}`);
  if (/[\x00-\x08\x0A-\x1F\x7F]/.test(headerValue)) fail('Header 值包含非法控制字符');
  if (key.toLowerCase() === 'content-type' && !headerValue) {
    fail('暂不支持通过空 Content-Type 抑制默认请求头');
  }
  return { key, value: headerValue, enabled: true };
}

function timeoutMs(value) {
  const milliseconds = Number(value) * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 2147483647) {
    fail('--max-time 需为大于 0 且不超过 2147483.647 的秒数');
  }
  return Math.ceil(milliseconds);
}

function queryPairs(body) {
  const pairs = [];
  for (const [key, value] of new URLSearchParams(body)) {
    if (pairs.length >= MAX_QUERY_PARAMS) fail(`查询参数过多（上限 ${MAX_QUERY_PARAMS}）`);
    pairs.push({ key, value, enabled: true });
  }
  return pairs;
}

function validateQueryCount(url) {
  const start = url.indexOf('?');
  if (start < 0) return;
  const end = url.indexOf('#', start);
  const query = url.slice(start + 1, end < 0 ? undefined : end);
  if (query && query.split('&').length > MAX_QUERY_PARAMS) {
    fail(`查询参数过多（上限 ${MAX_QUERY_PARAMS}）`);
  }
}

function isJsonContentType(headers) {
  const contentType = headers.find((header) => header.key.toLowerCase() === 'content-type');
  return !!contentType && /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(contentType.value);
}

export function parseCurl(command) {
  if (typeof command !== 'string' || !command.trim()) fail('请粘贴 cURL 命令');
  if (new TextEncoder().encode(command).length > MAX_COMMAND_BYTES) {
    fail(`cURL 命令超过导入上限 ${MAX_COMMAND_BYTES / 1024 / 1024}MB`);
  }
  const tokens = tokenize(command.replace(/^\uFEFF/, ''));
  const executable = tokens[0].replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (executable !== 'curl' && executable !== 'curl.exe') fail('请粘贴以 curl 开头的命令');

  let method = null;
  let url = null;
  let get = false;
  let head = false;
  let jsonData = false;
  let compressed = false;
  let followRedirects = false;
  let insecure = false;
  let requestTimeout = 30000;
  let basicAuthorization = null;
  let hasCustomAuthorization = false;
  let headers = [];
  const dataParts = [];
  const warnings = [];
  const positional = [];
  const setUrl = (value) => {
    if (url !== null) fail('一次只能导入一个 URL');
    url = value;
  };

  const takeValue = (args, index, attached, option) => {
    if (attached !== undefined) return attached;
    if (index + 1 >= args.length) fail(`${option} 缺少参数`);
    return args[index + 1];
  };
  const addHeader = (value) => {
    const parsed = parseHeader(value);
    if (parsed.key.toLowerCase() === 'authorization') hasCustomAuthorization = true;
    if (!parsed.value) return;
    headers.push(parsed);
  };
  const addUser = (value) => {
    basicAuthorization = basicAuth(value);
  };
  const addCookie = (value) => {
    if (!value.includes('=')) fail('-b/--cookie 的 Cookie 文件需要读取本地文件，请手动填写 Cookie');
    addHeader(`Cookie: ${value}`);
  };
  const addData = (value, option, encoded = false) => {
    if (!encoded && option !== '--data-raw' && value.startsWith('@')) {
      fail(`${option} 的 @file 需要读取本地文件，请手动配置 Body`);
    }
    if (option === '--data-ascii' && /[\r\n\0]/.test(value)) {
      fail('--data-ascii 包含控制字符，暂不支持自动转换');
    }
    dataParts.push(encoded ? encodeDataUrlencode(value) : value);
  };

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') {
      positional.push(...tokens.slice(i + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      positional.push(token);
      continue;
    }

    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const option = token.slice(2, eq < 0 ? undefined : eq);
      const attached = eq < 0 ? undefined : token.slice(eq + 1);
      if (FILE_OPTIONS.has(option)) fail(FILE_OPTIONS.get(option));
      if (['request', 'url', 'header', 'user', 'max-time', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'json', 'user-agent', 'referer', 'cookie', 'max-redirs'].includes(option)) {
        const value = takeValue(tokens, i, attached, `--${option}`);
        if (attached === undefined) i += 1;
        switch (option) {
          case 'request': method = value.toUpperCase(); break;
          case 'url': setUrl(value); break;
          case 'header': addHeader(value); break;
          case 'user': addUser(value); break;
          case 'max-time': requestTimeout = timeoutMs(value); break;
          case 'data':
          case 'data-raw':
          case 'data-binary':
          case 'data-ascii': addData(value, `--${option}`); break;
          case 'data-urlencode': addData(value, `--${option}`, true); break;
          case 'json': addData(value, option); jsonData = true; break;
          case 'user-agent': addHeader(`User-Agent: ${value}`); break;
          case 'referer': addHeader(`Referer: ${value}`); break;
          case 'cookie': addCookie(value); break;
          case 'max-redirs': {
            const count = Number(value);
            if (!Number.isInteger(count) || count !== 10) fail('应用重定向上限固定为 10，暂不支持 --max-redirs 的其他值');
            break;
          }
        }
        continue;
      }
      if (attached !== undefined) fail(`--${option} 不接受参数`);
      switch (option) {
        case 'location': followRedirects = true; break;
        case 'no-location': followRedirects = false; break;
        case 'insecure': insecure = true; break;
        case 'get': get = true; break;
        case 'head': head = true; break;
        case 'compressed': compressed = true; break;
        case 'silent':
        case 'show-error':
        case 'globoff':
        case 'basic': break;
        case 'verbose': warnings.push('已忽略 --verbose 的 curl 终端输出行为'); break;
        case 'connect-timeout': fail('应用只有总超时，请使用 --max-time 或导入后手动设置');
        case 'fail': fail('--fail 会改变错误语义，请导入后按响应状态自行判断');
        case 'include': fail('--include 会改变响应输出，应用分别展示状态、Headers 和 Body');
        case 'anyauth':
        case 'ntlm':
        case 'negotiate':
        case 'digest': fail('应用仅将 -u/--user 转为固定 Basic 认证');
        default: fail(`不支持的 cURL 选项: --${option}`);
      }
      continue;
    }

    const short = token.slice(1, 2);
    if (VALUE_ALIASES.has(short)) {
      const option = VALUE_ALIASES.get(short);
      const value = takeValue(tokens, i, token.length > 2 ? token.slice(2) : undefined, `-${short}`);
      if (token.length === 2) i += 1;
      if (option === 'request') method = value.toUpperCase();
      else if (option === 'header') addHeader(value);
      else if (option === 'user') addUser(value);
      else if (option === 'data-raw') addData(value, '-d');
      else if (option === 'user-agent') addHeader(`User-Agent: ${value}`);
      else if (option === 'referer') addHeader(`Referer: ${value}`);
      else addCookie(value);
      continue;
    }
    if (SHORT_FILE_OPTIONS.has(short)) fail(SHORT_FILE_OPTIONS.get(short));
    if (FILE_OPTIONS.has(token.slice(1))) fail(FILE_OPTIONS.get(token.slice(1)));
    if (/^-[kLsSgI]+$/.test(token)) {
      for (const flag of token.slice(1)) {
        if (flag === 'k') insecure = true;
        else if (flag === 'L') followRedirects = true;
        else if (flag === 'I') head = true;
      }
      continue;
    }
    if (token === '-G') {
      get = true;
      continue;
    }
    fail(`不支持的 cURL 选项: ${token}`);
  }

  for (const value of positional) setUrl(value);
  if (!url) fail('cURL 命令缺少 URL');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  if (!/^https?:\/\/\S+$/i.test(url)) fail('仅支持 http/https URL');
  validateQueryCount(url);

  if (get && head) fail('不能同时使用 --get 和 -I/--head');
  if (get && method && method !== 'GET') fail('--get 不能与非 GET 的显式方法组合');
  if (get && jsonData) fail('--get 不能与 --json 组合');
  if (!method) method = head ? 'HEAD' : (get || dataParts.length === 0 ? 'GET' : 'POST');
  if (!METHODS.has(method)) fail(`应用暂不支持方法 ${method}`);

  if (basicAuthorization !== null && !hasCustomAuthorization) {
    headers.push({ key: 'Authorization', value: basicAuthorization, enabled: true });
  }
  if (jsonData && !headers.some((header) => header.key.toLowerCase() === 'accept')) {
    headers.push({ key: 'Accept', value: 'application/json', enabled: true });
  }
  if (compressed && !headers.some((header) => header.key.toLowerCase() === 'accept-encoding')) {
    headers.push({ key: 'Accept-Encoding', value: 'gzip, deflate', enabled: true });
  }

  const split = splitUrl(url);
  let query = split.pairs;
  let fullUrl = url;
  let bodyType = 'none';
  let body = '';
  if (get && dataParts.length > 0) {
    query = [...query, ...queryPairs(dataParts.join('&'))];
    if (query.length > MAX_QUERY_PARAMS) fail(`查询参数过多（上限 ${MAX_QUERY_PARAMS}）`);
    fullUrl = joinUrl(split.base, query, split.hash);
  } else if (dataParts.length > 0) {
    body = dataParts.join('&');
    bodyType = jsonData || isJsonContentType(headers) ? 'json' : 'raw';
    if (!headers.some((header) => header.key.toLowerCase() === 'content-type')) {
      headers.push({
        key: 'Content-Type',
        value: jsonData ? 'application/json' : 'application/x-www-form-urlencoded',
        enabled: true,
      });
    }
  }
  if (/\$[A-Za-z_{]/.test(command)) {
    warnings.push('Shell 变量不会展开，$NAME 已按原文保留');
  }

  return {
    request: {
      method,
      url: fullUrl,
      headers,
      query,
      bodyType,
      body,
      formFields: [],
      binary: null,
      timeoutMs: requestTimeout,
      followRedirects,
      insecure,
    },
    warnings,
  };
}
