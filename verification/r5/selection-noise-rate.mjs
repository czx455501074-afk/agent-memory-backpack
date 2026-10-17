/**
 * How often does an unrelated query cause something to be injected?
 *
 * One reproduction is an anecdote. The number that decides how much this is worth fixing is a
 * rate, and a rate needs unrelated queries that share nothing with the library plus related
 * ones as a control. The control matters: if related queries also fail, the problem is not
 * about relevance at all.
 *
 * Each query goes through the real prepare path, including the model, so a run takes as long
 * as the model does. Nothing is written.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dataDir = process.env.AMB_DATA_DIR ?? join(homedir(), '.agent-memory-backpack');
const core = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8'));
const client = core.clients.find(c => c.id === 'dsh') ?? core.clients.find(c => c.role === 'adapter');
if (!client?.token) throw new Error('core.json 里没有适配器凭据。');
const base = `http://127.0.0.1:${core.port}`;

const UNRELATED = [
  '红烧肉怎么做才好吃，要放多少冰糖',
  '明天上海的天气和气温',
  '怎么训练三个月大的小猫用猫砂',
  '马拉松训练计划怎么安排配速',
  '钢琴初学者应该先练什么指法',
  '怎么选一台适合露营的越野车',
  '葡萄酒开瓶后能放几天',
  '怎样用烤箱做戚风蛋糕不塌陷',
];

const RELATED = [
  '召回预算与渐进披露',
  '插件部署后宿主没有加载新代码',
  '知识库候选队列怎么审核',
  '检索超时怎么归因',
];

async function ask(query) {
  const response = await fetch(`${base}/v1/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-amb-protocol': '1', authorization: `Bearer ${client.token}` },
    body: JSON.stringify({ projectId: client.projectId, sessionId: 'noise-rate', query, adapter: 'dsh' }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`/v1/prepare -> HTTP ${response.status}: ${text.slice(0, 200)}`);
  const prepared = JSON.parse(text);
  const selected = prepared.retrieval?.selected ?? [];
  const selection = prepared.retrieval?.selection ?? {};
  // An entry injected with no matching evidence is the case worth counting: it arrived without
  // anything connecting it to the request.
  const unevidenced = selected.filter(item => {
    const why = item.why ?? {};
    return Array.isArray(why.matched) && why.matched.length === 0;
  });
  return {
    query,
    mode: selection.mode,
    reason: selection.reason ?? '',
    selected: selected.length,
    unevidenced: unevidenced.length,
    kkinds: selected.map(item => item.kind).join(','),
    chars: prepared.context?.length ?? 0,
  };
}

async function run(label, queries) {
  const rows = [];
  for (const query of queries) {
    try {
      rows.push(await ask(query));
    } catch (error) {
      rows.push({ query, error: String(error).slice(0, 120) });
    }
  }
  const ok = rows.filter(row => !row.error);
  const injected = ok.filter(row => row.selected > 0);
  const unevidenced = ok.filter(row => row.unevidenced > 0);
  console.log(`\n【${label}】${ok.length} 次查询`);
  for (const row of ok) {
    console.log(`  ${row.selected > 0 ? '注入' : '未注入'} ${String(row.selected).padStart(2)} 条`
      + `（无证据 ${row.unevidenced}） mode=${row.mode} reason=${row.reason || '-'}`
      + ` ${String(row.chars).padStart(5)} 字符  「${row.query.slice(0, 18)}」 ${row.kkinds}`);
  }
  for (const row of rows.filter(r => r.error)) console.log(`  失败：${row.query} — ${row.error}`);
  if (!ok.length) {
    // 0/0 is not "no noise". A core that is still starting up, or a stale credential, makes
    // every query fail - and the first run of this script reported "注入 0/0" in that state,
    // which reads exactly like a clean result. Refuse to report a rate instead of reporting a
    // meaningless one.
    console.error(`\n无法测量「${label}」：${rows.length} 次查询全部失败。`
      + `\n第一个错误：${rows[0]?.error}\n这既不是「没有噪声」也不是「有噪声」——本次没有取得任何证据。`);
    process.exit(2);
  }
  const pct = n => ok.length ? `${((n / ok.length) * 100).toFixed(0)}%` : 'n/a';
  console.log(`  小结：注入 ${injected.length}/${ok.length}（${pct(injected.length)}）；`
    + `其中含零证据条目 ${unevidenced.length}/${ok.length}（${pct(unevidenced.length)}）`);
  return { injected: injected.length, unevidenced: unevidenced.length, total: ok.length };
}

const unrelated = await run('与库无关的查询', UNRELATED);
const related = await run('与库相关的查询（对照）', RELATED);

console.log(`\n结论：无关查询注入率 ${unrelated.injected}/${unrelated.total}，其中零证据注入 ${unrelated.unevidenced}/${unrelated.total}；`
  + `相关查询注入率 ${related.injected}/${related.total}。`);
console.log('若无关与相关两组的注入率接近，说明当前的选择层不能区分"有东西相关"与"只能给点东西"。');
