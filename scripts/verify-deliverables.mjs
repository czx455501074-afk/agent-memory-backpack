// Do the deliveries from previous rounds still exist?
//
// Why this exists: four workstreams overlapped on the same handful of files twice in
// one session, and each time a passing test suite could not answer "is the other
// line's entry point still there?" — a line that overwrites another usually brings a
// test that passes. Reviewing by eye does not scale, so the contract is written down
// once and checked mechanically.
//
// Each entry names a delivery, the file it lives in, and a pattern that must be
// present (or must be absent). Run after any round that touches the shared files.
//
// Usage: node scripts/verify-deliverables.mjs [--json]
// Exit code: 0 when every check passes, 1 otherwise.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const asJson = process.argv.includes('--json');

/** @type {{id: string, why: string, file: string, present?: RegExp, absent?: RegExp}[]} */
const checks = [
  {
    id: 'W1 规范参与检索',
    why: '检索曾整类排除规范，导致库里的规则用原话搜不到',
    file: 'src/retrieval-service.ts',
    absent: /!==\s*'norm'/,
  },
  {
    id: 'W1 排序按长度归一',
    why: '短规则曾被引用它的长文档压过',
    file: 'src/retrieval-index.ts',
    present: /Math\.log\(1 \+ Math\.min\(/,
  },
  {
    id: 'W2 分类器的自动升格判定',
    why: '经验曾被一键升格成参与门禁的规范',
    file: 'src/semantic.ts',
    present: /autoPromotable/,
  },
  {
    id: 'W3 队列聚合视图',
    why: '同类自动失败事实堆成无法审阅的长列表',
    file: 'src/store.ts',
    present: /queueProposals/,
  },
  {
    id: 'W4 任务收敛',
    why: '任务曾无限期挂在进行中',
    file: 'src/store.ts',
    present: /convergeTasks/,
  },
  {
    id: 'W6-1 准备路径携带已知版本',
    why: '不带版本时"版本未变只回指针"永不触发，每轮重发规范全文',
    file: 'adapters/dsh/index.mjs',
    present: /knowledgeRevision/,
  },
  {
    id: 'W7 面板走聚合视图',
    why: '面板默认视图若不请求聚合，折叠区等于不存在',
    file: 'adapters/dsh/client.js',
    present: /view:\s*'queue'|view=queue/,
  },
  {
    id: 'W9 宿主侧任务归档（DSH）',
    why: '回合结束时归档任务日记，否则只能等空闲超时这条慢路径',
    file: 'adapters/dsh/index.mjs',
    present: /archiveSessionTask/,
  },
  {
    id: 'W9 宿主侧任务归档（Codex）',
    why: '同一能力在另一宿主上必须也有',
    file: 'adapters/codex/scripts/hook.mjs',
    present: /archiveStoppedTurn|tasks\/archive/,
  },
  {
    id: 'W10 审核预填（服务端）',
    why: '模型已算完却被要求重填',
    file: 'src/server.ts',
    present: /prefill/,
  },
  {
    id: 'W10 类别可选（界面）',
    why: '采纳时必须由人选类别，缺省为记忆而非规范',
    file: 'src/ui.ts',
    present: /pe-kind/,
  },
  {
    id: 'W11 单一归属判定源',
    why: '列表与详情曾对同一候选给出相反结论',
    file: 'src/store.ts',
    present: /resolveAttribution/,
  },
  {
    id: 'W11 候选项显式形状',
    why: '按 kind 分支的调用方曾把普通候选读成 undefined',
    file: 'src/store.ts',
    present: /kind:\s*'candidate'/,
  },
  {
    id: 'W12 召回字符预算',
    why: '召回段落曾无上限地整段注入',
    file: 'adapters/dsh/recall.mjs',
    present: /[Bb]udget/,
  },
  // --- blockers, expected to be present once implemented ---
  {
    id: 'B1 服务端强制审核门禁',
    why: '门禁此前只在一个客户端里，服务端不查分类判定',
    file: 'src/server.ts',
    present: /classificationAcknowledged|classificationNote/,
  },
  {
    id: 'B2 判定器版本可查',
    why: '不记版本时，判定器每次改进都会留下静默的新旧混用',
    file: 'src/semantic.ts',
    present: /classifierVersion|CLASSIFIER_VERSION/,
  },
  {
    id: 'B2 回填入口',
    why: '存量判定是写入时快照，需要可重算的入口',
    file: 'src/store.ts',
    present: /reclassify/i,
  },
  {
    id: 'B3 捕获来源分类',
    why: '并发编辑冲突曾被当成值得沉淀的经验',
    file: 'src/refine.ts',
    present: /tool_collision/,
  },
];

const results = checks.map(check => {
  const path = join(root, check.file);
  if (!existsSync(path)) return { ...check, ok: false, detail: '文件不存在' };
  const text = readFileSync(path, 'utf8');
  if (check.present && !check.present.test(text)) return { ...check, ok: false, detail: `缺少 ${check.present}` };
  if (check.absent && check.absent.test(text)) return { ...check, ok: false, detail: `仍存在应当移除的 ${check.absent}` };
  return { ...check, ok: true, detail: 'ok' };
});

if (asJson) {
  console.log(JSON.stringify(results.map(({ id, file, ok, detail }) => ({ id, file, ok, detail })), null, 2));
} else {
  const pending = new Set(['B1 服务端强制审核门禁', 'B2 判定器版本可查', 'B2 回填入口', 'B3 捕获来源分类']);
  console.log('此前各轮的交付是否还在（逐条契约检查）\n');
  for (const result of results) {
    const tag = result.ok ? 'PASS' : (pending.has(result.id) ? 'TODO' : 'FAIL');
    console.log(`${tag.padEnd(5)} ${result.id.padEnd(26)} ${result.ok ? '' : `← ${result.detail}（${result.file}）`}`);
  }
  const failed = results.filter(result => !result.ok && !pending.has(result.id));
  console.log(`\n${results.filter(result => result.ok).length}/${results.length} 通过；未实现的阻塞项 ${results.filter(result => !result.ok && pending.has(result.id)).length} 项，失败 ${failed.length} 项。`);
}
process.exit(results.some(result => !result.ok && !['B1 服务端强制审核门禁', 'B2 判定器版本可查', 'B2 回填入口', 'B3 捕获来源分类'].includes(result.id)) ? 1 : 0);
