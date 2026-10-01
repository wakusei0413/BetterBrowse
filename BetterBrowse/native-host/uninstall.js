/**
 * @file uninstall.js
 * @description AI 桥接本机宿主卸载器（移除 Native Messaging 注册与自发现残留文件）
 *
 * 用法：deno task ai-host-uninstall [--browser=chrome|edge]
 * 只移除指定浏览器的注册；另一浏览器仍在使用时保留共用的启动器。
 * @encoding UTF-8
 */

import { join } from 'jsr:@std/path@^1.0.8';
import {
  legacyWindowsManifestPath,
  parseArgs,
  parseBrowser,
  readRegistryDefault,
  resolveRegistration,
  stateDirPath
} from './host-paths.js';

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function removeIfExists(path) {
  try {
    await Deno.remove(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const browser = parseBrowser(parseArgs(Deno.args));
  const otherBrowser = browser === 'edge' ? 'chrome' : 'edge';
  const { mode, manifestPath, registryKey } = resolveRegistration(browser);
  const other = resolveRegistration(otherBrowser);

  if (mode === 'registry') {
    const output = await new Deno.Command('reg', {
      args: ['delete', registryKey, '/f'],
      stdout: 'piped',
      stderr: 'piped'
    }).output();
    if (!output.success) {
      console.log('注册表项不存在或已删除（跳过）');
    }
  }

  if (await removeIfExists(manifestPath)) {
    console.log(`已删除宿主清单：${manifestPath}`);
  } else {
    console.log('宿主清单不存在（跳过）');
  }

  // 另一浏览器是否仍在使用宿主（Windows 查注册表，其它平台查清单文件）
  const otherRegistered = other.mode === 'registry'
    ? Boolean(await readRegistryDefault(other.registryKey))
    : await Deno.stat(other.manifestPath).then(() => true, () => false);

  if (mode === 'registry' && !otherRegistered) {
    // 旧版安装器写入的共用清单：两个浏览器都已注销后才清理
    await removeIfExists(legacyWindowsManifestPath());
  }

  if (otherRegistered) {
    console.log(`${otherBrowser} 仍注册了 AI 桥接宿主，保留共用启动器`);
  } else {
    // 清理生成的启动器（bridge.json 由宿主进程退出时自行删除，这里不动仍在运行的宿主）
    const stateDir = stateDirPath();
    for (const leftover of ['run-host.cmd', 'run-host.sh']) {
      if (await removeIfExists(join(stateDir, leftover))) console.log(`已清理：${leftover}`);
    }
  }

  console.log('✅ AI 桥接宿主已卸载');
}

await main();
