/**
 * Why did prepare pick these entries?
 *
 * The response carries a `why` per selected entry and a `selection` verdict for the whole
 * choice, and both are computed rather than guessed. This asks the running core the same
 * question a task would, so the answer describes the real path instead of my reading of it.
 *
 * Usage: node verification/r5/selection-why.mjs [query]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dataDir = process.env.AMB_DATA_DIR ?? join(homedir(), '.agent-memory-backpack');
const core = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8'));
const client = core.clients.find(c => c.id === 'dsh') ?? core.clients.find(c => c.role === 'adapter');
if (!client?.token) throw new Error('core.json 里没有适配器凭据。');
const base = `http://127.0.0.1:${core.port}`;

const query = process.argv[2] ?? '给 Agent Memory Backpack 插件加一个召回预算，并验证效果';

const response = await fetch(`${base}/v1/prepare`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-amb-protocol': '1', authorization: `Bearer ${client.token}` },
  body: JSON.stringify({ projectId: client.projectId, sessionId: 'selection-why', query, adapter: 'dsh' }),
});
const text = await response.text();
if (!response.ok) throw new Error(`/v1/prepare -> HTTP ${response.status}: ${text.slice(0, 300)}`);
const prepared = JSON.parse(text);

console.log(`查询：${query}`);
const selection = prepared.retrieval?.selection ?? prepared.selection;
console.log(`选择方式：mode=${selection?.mode} reason=${selection?.reason ?? '(无)'}`);
const selected = prepared.retrieval?.selected ?? [];
// `selectedIds` lives on the selection verdict, not on the retrieval receipt - reading it off
// the wrong object is why the first run of this script printed "命中 0 条" beside three
// selected entries.
const ids = selection?.selectedIds ?? [];
console.log(`模型/索引命中 ${ids.length} 条；本次检索共选中 ${selected.length} 条；注入上下文 ${prepared.context?.length ?? 0} 字符\n`);

console.log('被选中的条目及理由：');
for (const item of selected) {
  const isNorm = String(item.id).startsWith('norm:');
  console.log(`  [${item.kind}] ${item.id}${isNorm ? '  ← 规范' : ''}`);
  // `why` is an object, not a string: stringifying it is the difference between a usable
  // reason and the word "[object Object]".
  console.log(`      why: ${typeof item.why === 'string' ? item.why : JSON.stringify(item.why)}`);
}

// The injected text is what the agent actually receives, so name which injected lines are
// skills - the population that dominated this library (149 of 394 adopted entries).
const skillLines = (prepared.context ?? '').split('\n\n').filter(block => block.startsWith('已采纳技能'));
console.log(`\n注入文本里的技能块：${skillLines.length} 个`);
for (const block of skillLines) console.log(`  ${block.split('\n')[0].slice(0, 120)}`);

console.log(`\n未命中片段（gaps）：${(prepared.retrieval?.gaps ?? []).slice(0, 12).join('、') || '(无)'}`);
