/**
 * How many characters the prepare path used to spend on workflow detail, measured on the
 * real library.
 *
 * The change is not "the code is different now", it is "this many characters no longer
 * travel on every prepare". So the script fetches a real prepare response, rebuilds the
 * workflow section in BOTH shapes from the same structured data, and prints the difference.
 * Nothing is written; the library is read through the running core.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dataDir = process.env.AMB_DATA_DIR ?? join(homedir(), '.agent-memory-backpack');
const core = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8'));
// Same identity choice as the live verifier: /v1/prepare refuses an admin credential
// ("an admin is not an adapter"), so the adapter token for this host is the one to use.
const client = core.clients.find(c => c.id === 'dsh') ?? core.clients.find(c => c.role === 'adapter');
if (!client?.token) throw new Error('core.json 里没有适配器凭据，无法按宿主的方式提问。');
const base = `http://127.0.0.1:${core.port}`;

async function post(route, body) {
  const response = await fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-amb-protocol': '1', authorization: `Bearer ${client.token}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  // Print what the core said, not just the status: a 403 from this route means the identity
  // was wrong, and the core explains which kind of wrong.
  if (!response.ok) throw new Error(`${route} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const prepared = await post('/v1/prepare', {
  projectId: client.projectId,
  sessionId: 'workflow-budget-measure',
  query: process.argv[2] ?? '继续推进项目',
  adapter: 'dsh',
});

const workflows = prepared.workflows ?? [];
if (workflows.length === 0) {
  console.log('本次 prepare 没有选中任何 workflow，无法测量。换一个能命中流程的 query 再跑。');
  process.exit(0);
}

// The before shape is reproduced exactly as it was written, including the trailing period
// and the per-stage check lists, so the comparison is against the real previous text and
// not against a paraphrase of it.
const before = workflows.map(w => `完整流程 ${w.id}@${w.revision} ${w.title}\n${w.overview}\n前提: ${w.preconditions.join('；')}\n阶段: ${w.stages.map(s => `${s.id}:${s.title}（检查:${s.checks.join('；')}）`).join(' → ')}\n完成: ${w.completion.join('；')}\n恢复: ${w.recovery}\n${w.ready ? '执行阶段前调用 amb_read_stage 读取完整阶段和必需依赖。' : `不可执行: ${w.unavailable}`}`);
const after = workflows.map(w => `完整流程 ${w.id}@${w.revision} ${w.title}\n${w.overview}\n前提: ${w.preconditions.join('；')}\n阶段: ${w.stages.map(s => `${s.id}:${s.title}`).join(' → ')}\n完成: ${w.completion.join('；')}\n${w.ready ? `执行阶段前调用 amb_read_stage 读取该阶段的检查项与必需依赖（共 ${w.stages.length} 个阶段；失败时的恢复步骤也在其中）。` : `不可执行: ${w.unavailable}`}`);

const sum = rows => rows.reduce((total, row) => total + row.length, 0);
const charsBefore = sum(before);
const charsAfter = sum(after);
const wholeBefore = prepared.context.length;
// The prepare payload already reflects the new shape, so the old total is the new total plus
// the difference in this section.
const wholeAfter = wholeBefore - (charsBefore - charsAfter);

console.log(`本次 prepare 选中 workflow ${workflows.length} 个，阶段合计 ${workflows.reduce((n, w) => n + w.stages.length, 0)} 个。`);
console.log(`workflow 段：改前 ${charsBefore} 字符 → 改后 ${charsAfter} 字符（省 ${charsBefore - charsAfter}，${((1 - charsAfter / charsBefore) * 100).toFixed(1)}%）`);
console.log(`整个 prepare 上下文：改前约 ${wholeBefore + (charsBefore - charsAfter)} 字符 → 改后 ${wholeBefore} 字符（省 ${charsBefore - charsAfter}）`);
console.log(`逐条：`);
for (const [index, w] of workflows.entries()) {
  console.log(`  ${w.id}  阶段 ${w.stages.length}  检查项 ${w.stages.reduce((n, s) => n + s.checks.length, 0)}  ${before[index].length} → ${after[index].length}`);
}
console.log(`\n仍然随流程一起到达的：概览、前提、阶段顺序与标题、完成条件；另外用一行说明告知 amb_read_stage 可读什么。`);
