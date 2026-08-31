/**
 * @file runtime-logger.js
 * @description 跨扩展上下文的统一控制台日志捕获器（保留原生输出并旁路持久化）
 * @encoding UTF-8
 */

const LEVELS = ['debug', 'info', 'warn', 'error'];
const MAX_DEPTH = 5;
const MAX_MESSAGE_LENGTH = 4000;
const SENSITIVE_KEY = /(password|passwd|token|authorization|credential|secret|cookie)/i;
const SOURCE_PREFIX = /^\[([^\]]+)]\s*/;
const SENSITIVE_TEXT = /(password|passwd|token|authorization|credential|secret|cookie)(\s*[=:]\s*)([^\s,;}&]+)/gi;
const INSTALLED_FLAG = Symbol.for('betterbrowse.runtimeLoggerInstalled');

function sanitize(value, seen, depth = 0, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[已遮蔽]';
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack || '' };
  }
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[函数 ${value.name || '匿名'}]`;
  if (typeof value !== 'object') return String(value);
  if (depth >= MAX_DEPTH) return '[深度已截断]';
  if (seen.has(value)) return '[循环引用]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, seen, depth + 1));
  const output = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 50)) {
    output[childKey] = sanitize(childValue, seen, depth + 1, childKey);
  }
  return output;
}

function stringify(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(sanitize(value, new WeakSet()));
  } catch {
    return String(value);
  }
}

export function normalizeConsoleEntry(level, args, context) {
  const values = Array.isArray(args) ? args : [];
  let source = context || 'BetterBrowse';
  if (typeof values[0] === 'string') {
    const match = values[0].match(SOURCE_PREFIX);
    if (match) source = match[1];
  }
  const message = values
    .map(stringify)
    .join(' ')
    .replace(SENSITIVE_TEXT, '$1$2[已遮蔽]')
    .slice(0, MAX_MESSAGE_LENGTH) || '-';
  return { ts: Date.now(), level, source, context, category: 'runtime', message };
}

export function installRuntimeLogger({ context = 'background', write }) {
  if (console[INSTALLED_FLAG] || typeof write !== 'function') return;
  Object.defineProperty(console, INSTALLED_FLAG, { value: true, configurable: true });
  for (const level of LEVELS) {
    const nativeMethod = console[level]?.bind(console) || console.log.bind(console);
    console[level] = (...args) => {
      nativeMethod(...args);
      try {
        Promise.resolve(write(normalizeConsoleEntry(level, args, context))).catch(() => {});
      } catch {
        // 日志旁路失败不得影响原业务
      }
    };
  }
}
