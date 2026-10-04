/**
 * @file host-paths.js
 * @description AI 桥接宿主安装器与卸载器共用的路径、注册位置与参数解析
 * @encoding UTF-8
 */

import { join } from 'jsr:@std/path@^1.0.8';

export const HOST_NAME = 'com.betterbrowse.bridge';

/**
 * 解析命令行参数（--key=value 形式）
 * @param {string[]} args
 * @returns {Record<string, string>}
 */
export function parseArgs(args) {
  const parsed = {};
  for (const arg of args) {
    const match = /^--([a-zA-Z-]+)=(.*)$/.exec(arg);
    if (match) parsed[match[1]] = match[2];
  }
  return parsed;
}

/**
 * @param {Record<string, string>} args
 * @returns {'chrome' | 'edge'}
 */
export function parseBrowser(args) {
  return args.browser === 'edge' ? 'edge' : 'chrome';
}

function homeDir() {
  return Deno.env.get('USERPROFILE') || Deno.env.get('HOME') || '.';
}

/**
 * 用户状态目录（bridge.json 自发现文件、生成的启动器与 Windows 宿主清单所在位置）
 * @returns {string}
 */
export function stateDirPath() {
  if (Deno.build.os === 'windows') {
    return join(Deno.env.get('LOCALAPPDATA') || join(homeDir(), 'AppData', 'Local'), 'BetterBrowse');
  }
  return join(Deno.env.get('XDG_STATE_HOME') || join(homeDir(), '.local', 'state'), 'better-browse');
}

/**
 * 当前系统的浏览器 Native Messaging 注册位置。
 * Windows 下清单文件按浏览器分开命名：Chrome 与 Edge 共用同一个清单会互相覆盖
 * allowed_origins，卸载其中一个也会删掉另一个仍在引用的文件。
 * @param {'chrome' | 'edge'} browser
 * @returns {{ dir: string, manifestPath: string, mode: 'file' | 'registry', registryKey?: string }}
 */
export function resolveRegistration(browser) {
  const os = Deno.build.os;
  if (os === 'windows') {
    const dir = stateDirPath();
    return {
      dir,
      manifestPath: join(dir, `${HOST_NAME}.${browser}.json`),
      mode: 'registry',
      registryKey: browser === 'edge'
        ? `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`
        : `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`
    };
  }
  const base = os === 'darwin'
    ? join(homeDir(), 'Library', 'Application Support')
    : join(homeDir(), '.config');
  const dir = os === 'darwin'
    ? join(base, browser === 'edge' ? 'Microsoft Edge' : join('Google', 'Chrome'), 'NativeMessagingHosts')
    : join(base, browser === 'edge' ? 'microsoft-edge' : 'google-chrome', 'NativeMessagingHosts');
  return { dir, manifestPath: join(dir, `${HOST_NAME}.json`), mode: 'file' };
}

/** 旧版 Windows 安装器写入的、Chrome 与 Edge 共用的清单路径 */
export function legacyWindowsManifestPath() {
  return join(stateDirPath(), `${HOST_NAME}.json`);
}

/**
 * 查询注册表项默认值（不存在返回空串）
 * @param {string} key
 * @returns {Promise<string>}
 */
export async function readRegistryDefault(key) {
  try {
    const output = await new Deno.Command('reg', {
      args: ['query', key, '/ve'],
      stdout: 'piped',
      stderr: 'piped'
    }).output();
    if (!output.success) return '';
    const match = /REG_SZ\s+(.+)$/m.exec(new TextDecoder().decode(output.stdout));
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}
