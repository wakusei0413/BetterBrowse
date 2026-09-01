/**
 * @file bump-api-version.js
 * @description 将 BetterBrowse 内部 API 版本裸整数递增一次
 * @encoding UTF-8
 */

import { dirname, fromFileUrl, resolve } from '@std/path';

const projectRoot = resolve(dirname(fromFileUrl(import.meta.url)), '..');
const sourcePath = resolve(projectRoot, 'src/constants/api-version.js');

const source = await Deno.readTextFile(sourcePath);
const match = /export const API_VERSION = (\d+);/.exec(source);
if (!match) throw new Error('无法从 api-version.js 读取 API_VERSION');

const current = Number(match[1]);
if (!Number.isSafeInteger(current) || current < 1) throw new Error('API_VERSION 必须为裸正整数');
const next = current + 1;

const updatedSource = source.replace(match[0], `export const API_VERSION = ${next};`);
await Deno.writeTextFile(sourcePath, updatedSource);
console.log(`API 版本已从 ${current} 递增至 ${next}`);
