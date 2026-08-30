/**
 * @file uninstall.js
 * @description AI 桥接本机宿主卸载器（移除 Native Messaging 注册与自发现残留文件）
 *
 * 用法：deno task ai-host-uninstall [--browser=chrome|edge]
 * @encoding UTF-8
 */

import { join } from 'jsr:@std/path@^1.0.8';

const HOST_NAME = 'com.betterbrowse.bridge';

function parseArgs(args) {
  const parsed = {};
  for (const arg of args) {
    const match = /^--([a-zA-Z-]+)=(.*)$/.exec(arg);
    if (match) parsed[match[1]] = match[2];
  }
  return parsed;
}

function resolveRegistration(browser) {
  const home = Deno.env.get('USERPROFILE') || Deno.env.get('HOME') || '.';
  const os = Deno.build.os;
  if (os === 'windows') {
    const dir = join(Deno.env.get('LOCALAPPDATA') || join(home, 'AppData', 'Local'), 'BetterBrowse');
    return { dir, mode: 'registry', registryKey: browser === 'edge'
      ? 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.betterbrowse.bridge'
      : 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.betterbrowse.bridge' };
  }
  if (os === 'darwin') {
    const base = join(home, 'Library', 'Application Support');
    const dir = browser === 'edge'
      ? join(base, 'Microsoft Edge', 'NativeMessagingHosts')
      : join(base, 'Google', 'Chrome', 'NativeMessagingHosts');
    return { dir, mode: 'file' };
  }
  const base = join(home, '.config');
  const dir = browser === 'edge'
    ? join(base, 'microsoft-edge', 'NativeMessagingHosts')
    : join(base, 'google-chrome', 'NativeMessagingHosts');
  return { dir, mode: 'file' };
}

async function main() {
  const args = parseArgs(Deno.args);
  const browser = args.browser === 'edge' ? 'edge' : 'chrome';
  const { dir, mode, registryKey } = resolveRegistration(browser);

  if (mode === 'registry') {
    const command = new Deno.Command('reg', {
      args: ['delete', registryKey, '/f'],
      stdout: 'piped',
      stderr: 'piped'
    });
    const output = await command.output();
    if (!output.success) {
      console.log('注册表项不存在或已删除（跳过）');
    }
  }

  try {
    await Deno.remove(join(dir, `${HOST_NAME}.json`));
    console.log(`已删除宿主清单：${join(dir, `${HOST_NAME}.json`)}`);
  } catch {
    console.log('宿主清单不存在（跳过）');
  }

  // 清理生成的启动器与可能残留的自发现文件（正常由宿主进程退出时自行删除）
  const stateDir = Deno.build.os === 'windows'
    ? join(Deno.env.get('LOCALAPPDATA') || '.', 'BetterBrowse')
    : join(Deno.env.get('XDG_STATE_HOME') || join(Deno.env.get('HOME') || '.', '.local', 'state'), 'better-browse');
  for (const leftover of ['run-host.cmd', 'run-host.sh', 'bridge.json']) {
    try {
      await Deno.remove(join(stateDir, leftover));
      console.log(`已清理：${leftover}`);
    } catch {
      // 文件不存在视为已清理
    }
  }

  console.log('✅ AI 桥接宿主已卸载');
}

await main();
