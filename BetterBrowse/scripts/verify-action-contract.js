/**
 * @file verify-action-contract.js
 * @description 校验后台动作、AI 能力文档、内容白名单与人类界面的静态契约
 * @encoding UTF-8
 */

import { dirname, fromFileUrl, resolve } from '@std/path';

const projectRoot = resolve(dirname(fromFileUrl(import.meta.url)), '..');

/** 从 ActionTypes 对象中读取字符串动作值。 */
function extractActionTypes(source) {
  return new Set([...source.matchAll(/(?:^|[{,])\s*([A-Z][A-Z0-9_]*)\s*:\s*['"]([^'"]+)['"]/gm)].map((m) => m[2]));
}

/** 读取所有使用 ActionTypes.X 形式声明的动作键。 */
function extractActionTypeReferences(source) {
  return new Set([...source.matchAll(/ActionTypes\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
}

/** 读取计算属性 [ActionTypes.X] 形成的对象键。 */
function extractComputedActionValues(source) {
  return new Set([...source.matchAll(/\[ActionTypes\.([A-Z][A-Z0-9_]*)\]\s*:/g)].map((m) => m[1]));
}

/** 读取 Set 中的 ActionTypes.X 成员。 */
function extractSetActionValues(source, setName) {
  const start = source.indexOf(`export const ${setName}`);
  if (start < 0) return new Set();
  const open = source.indexOf('[', start);
  const close = source.indexOf(']);', open);
  if (open < 0 || close < 0) return new Set();
  return new Set([...source.slice(open, close).matchAll(/ActionTypes\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
}

/** 读取数组中的 ActionTypes.X 成员。 */
function extractArrayActionValues(source, arrayName) {
  const start = source.indexOf(`const ${arrayName} = [`);
  if (start < 0) return new Set();
  const close = source.indexOf('];', start);
  if (close < 0) return new Set();
  return new Set([...source.slice(start, close).matchAll(/ActionTypes\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
}

function sorted(values) {
  return [...values].sort();
}

function addMissing(failures, rule, values, universe) {
  const missing = sorted([...values].filter((value) => !universe.has(value)));
  if (missing.length > 0) failures.push(`${rule}：${missing.join(', ')}`);
}

/**
 * 对输入源码执行动作契约检查，便于测试与工具复用。
 * @param {{ actionTypes: string, handlers: string, capabilities: string, authorizer: string, humanUi: string }} sources
 * @returns {{ pass: boolean, failures: string[], sets: Record<string, string[]> }}
 */
export function checkActionContractSources(sources) {
  const actionTypes = extractActionTypes(sources.actionTypes || '');
  const handlerKeys = extractComputedActionValues(sources.handlers || '');
  const docs = extractComputedActionValues(sources.capabilities || '');
  const confirm = extractSetActionValues(sources.capabilities || '', 'AI_CONFIRM_REQUIRED_ACTIONS');
  const content = extractSetActionValues(sources.authorizer || '', 'CONTENT_ALLOWED_ACTIONS');
  const human = extractArrayActionValues(sources.humanUi || '', 'HUMAN_UI_ACTIONS');
  const failures = [];

  addMissing(failures, 'handler 映射中的动作缺少 AI_ACTION_DOCS 文档', handlerKeys, docs);
  addMissing(failures, 'AI_ACTION_DOCS 中存在未定义的 ActionTypes 动作', docs, actionTypes);
  addMissing(failures, 'AI_CONFIRM_REQUIRED_ACTIONS 中存在未定义的 ActionTypes 动作', confirm, actionTypes);
  addMissing(failures, 'CONTENT_ALLOWED_ACTIONS 中没有对应 handler', content, handlerKeys);
  addMissing(failures, 'HUMAN_UI_ACTIONS 中缺少 AI_ACTION_DOCS 文档', human, docs);

  // 这些动作虽然名字含破坏性词，但当前 UI 语义是单条规则/条目的普通编辑，
  // 不属于 AI 桥接确认位红线；若未来改变语义，必须从这里移除并补入确认集合。
  const destructiveConfirmExemptions = new Set([
    'CLEAR_DOMAIN_RULES',
    'REMOVE_DOMAIN_RULE',
    'DELETE_STASH_ITEM'
  ]);
  const destructive = [...actionTypes].filter((action) =>
    !destructiveConfirmExemptions.has(action)
      && (/(?:DELETE|CLEAR|RESET|REMOVE)/.test(action) || action === 'RESTORE_FULL_BACKUP')
  );
  const destructiveMissingConfirm = destructive.filter((action) => !confirm.has(action));
  if (destructiveMissingConfirm.length > 0) {
    failures.push(`不可逆动作缺少 AI_CONFIRM_REQUIRED_ACTIONS 确认位：${sorted(destructiveMissingConfirm).join(', ')}`);
  }

  return {
    pass: failures.length === 0,
    failures,
    sets: {
      actionTypes: sorted(actionTypes),
      handlerKeys: sorted(handlerKeys),
      docs: sorted(docs),
      confirm: sorted(confirm),
      content: sorted(content),
      human: sorted(human)
    }
  };
}

/** 对真实仓库文件执行契约检查并打印具体失败项。 */
export async function runActionContractChecks(root = projectRoot) {
  const read = (path) => Deno.readTextFile(resolve(root, path));
  const sources = {
    actionTypes: await read('src/constants/action-types.js'),
    handlers: await read('src/background/action-handlers.js'),
    capabilities: await read('src/core/ai/ai-capabilities.js'),
    authorizer: await read('src/core/security/message-authorizer.js'),
    humanUi: await read('../tests/ai-bridge.test.js')
  };
  const result = checkActionContractSources(sources);
  if (result.pass) {
    console.log(`[PASS] 动作静态契约完整（handler ${result.sets.handlerKeys.length} 项，AI 文档 ${result.sets.docs.length} 项）`);
  } else {
    for (const failure of result.failures) console.error(`[FAIL] ${failure}`);
  }
  return result;
}

if (import.meta.main) {
  const result = await runActionContractChecks();
  if (!result.pass) Deno.exit(1);
}
