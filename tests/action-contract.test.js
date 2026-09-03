/**
 * @file action-contract.test.js
 * @description 后台动作静态契约校验器回归测试
 * @encoding UTF-8
 */

import { assertEquals, assert } from '@std/assert';
import { checkActionContractSources, runActionContractChecks } from '../BetterBrowse/scripts/verify-action-contract.js';

const base = {
  actionTypes: "export const ActionTypes = { GET_A: 'GET_A', DELETE_A: 'DELETE_A' };",
  handlers: 'const handlers = { [ActionTypes.GET_A]: async () => {}, [ActionTypes.DELETE_A]: async () => {} };',
  capabilities: 'export const AI_CONFIRM_REQUIRED_ACTIONS = new Set([ActionTypes.DELETE_A]); export const AI_ACTION_DOCS = { [ActionTypes.GET_A]: { summary: \'读\' }, [ActionTypes.DELETE_A]: { summary: \'删\' } };',
  authorizer: 'const CONTENT_ALLOWED_ACTIONS = new Set([ActionTypes.GET_A]);',
  humanUi: 'const HUMAN_UI_ACTIONS = [ActionTypes.GET_A];'
};

Deno.test('动作契约：缺少 AI 文档时报告具体动作名', () => {
  const result = checkActionContractSources({
    ...base,
    capabilities: 'export const AI_CONFIRM_REQUIRED_ACTIONS = new Set([ActionTypes.DELETE_A]); export const AI_ACTION_DOCS = { [ActionTypes.GET_A]: { summary: \'读\' } };'
  });
  assertEquals(result.pass, false);
  assert(result.failures.some((failure) => failure.includes('DELETE_A')));
});

Deno.test('动作契约：破坏性动作缺少确认位时报告具体动作名', () => {
  const result = checkActionContractSources({
    ...base,
    capabilities: 'export const AI_CONFIRM_REQUIRED_ACTIONS = new Set([]); export const AI_ACTION_DOCS = { [ActionTypes.GET_A]: { summary: \'读\' }, [ActionTypes.DELETE_A]: { summary: \'删\' } };'
  });
  assertEquals(result.pass, false);
  assert(result.failures.some((failure) => failure.includes('DELETE_A') && failure.includes('确认位')));
});

Deno.test('动作契约：真实仓库文件通过静态检查', async () => {
  const result = await runActionContractChecks();
  assertEquals(result.pass, true, result.failures.join('\n'));
});
