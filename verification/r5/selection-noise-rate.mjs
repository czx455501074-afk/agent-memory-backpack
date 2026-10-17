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

// Kept broad on purpose: cooking, weather, pets, sport, music, cars, drink, baking, finance,
// law, medicine, travel, gardening, photography, chess, knitting. A rate computed from eight
// queries is a hint; a rate from thirty-two can be quoted.
const UNRELATED = [
  '红烧肉怎么做才好吃，要放多少冰糖',
  '明天上海的天气和气温',
  '怎么训练三个月大的小猫用猫砂',
  '马拉松训练计划怎么安排配速',
  '钢琴初学者应该先练什么指法',
  '怎么选一台适合露营的越野车',
  '葡萄酒开瓶后能放几天',
  '怎样用烤箱做戚风蛋糕不塌陷',
  '指数基金和主动基金怎么选',
  '租房合同里押金条款要注意什么',
  '偏头痛发作时应该吃什么药',
  '去冰岛自驾需要准备什么装备',
  '阳台上种薄荷需要注意什么',
  '拍星空要用什么参数',
  '国际象棋开局应该学哪几套',
  '毛线围巾起针要起多少针',
  '怎么判断西瓜熟没熟',
  '高铁上能不能带宠物',
  '电饭锅煮糙米要加多少水',
  '孩子换牙期间要注意什么',
  '羽毛球拍磅数怎么选',
  '汽车电瓶亏电了怎么应急启动',
  '怎样把旧照片扫描成电子版',
  '钢琴调律多久做一次',
  '登山鞋要不要买大半码',
  '怎么给绿萝换盆不伤根',
  '煮咖啡的水温应该多少度',
  '怎样去除衣服上的油渍',
  '摩托车头盔怎么选尺寸',
  '学游泳先学哪种泳姿',
  '怎么挑选适合自己的跑鞋',
  '冰箱冷藏室温度设多少合适',
];

const RELATED = [
  '召回预算与渐进披露',
  '插件部署后宿主没有加载新代码',
  '知识库候选队列怎么审核',
  '检索超时怎么归因',
  '候选采纳的服务端门禁',
  '迁移包的导出与导入',
  '知识条目的版本沿革',
  '任务结束时的日记归档',
  '待审候选的分类判定回填',
  '适配器的凭据隔离',
  '召回注入的字符预算',
  '记忆检索的索引评分',
];

async function ask(query) {
  const started = Date.now();
  const response = await fetch(`${base}/v1/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-amb-protocol': '1', authorization: `Bearer ${client.token}` },
    body: JSON.stringify({ projectId: client.projectId, sessionId: 'noise-rate', query, adapter: 'dsh' }),
  });
  const elapsed = Date.now() - started;
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
    ms: elapsed,
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
  // How often the model actually answered, as opposed to the fallback carrying the decision.
  // Without this number, "the fallback is noisy" says nothing about how often that matters.
  const modes = new Map();
  for (const row of ok) modes.set(row.mode, (modes.get(row.mode) ?? 0) + 1);
  const reasons = new Map();
  for (const row of ok) if (row.reason) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
  console.log(`  mode 分布：${[...modes].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (reasons.size) console.log(`  降级原因：${[...reasons].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  // The model budget is a fixed 2500ms and a timeout falls back to the weaker local path, so
  // where the model's own latency sits relative to that number is the whole question. A median
  // tells whether the budget is generous; the slowest cases tell how much of the tail it cuts.
  const times = ok.map(row => row.ms).sort((a, b) => a - b);
  const at = q => times.length ? times[Math.min(times.length - 1, Math.floor(times.length * q))] : 0;
  console.log(`  prepare 耗时：中位 ${at(0.5)}ms  最快 ${times[0] ?? 0}ms  P90 ${at(0.9)}ms  最慢 ${times.at(-1) ?? 0}ms`);
  const met = ok.filter(row => row.mode === 'model');
  if (met.length) {
    const answered = met.map(row => row.ms).sort((a, b) => a - b);
    console.log(`  其中模型真正作答的 ${met.length} 次耗时：中位 ${answered[Math.floor(answered.length / 2)]}ms  最慢 ${answered.at(-1)}ms`);
  }
  const timedOut = ok.filter(row => row.reason === 'local_index:model_timeout');
  if (timedOut.length) console.log(`  超时的 ${timedOut.length} 次耗时：${timedOut.map(row => `${row.ms}ms`).join(' ')}`);
  console.log(`  小结：注入 ${injected.length}/${ok.length}（${pct(injected.length)}）；`
    + `其中含零证据条目 ${unevidenced.length}/${ok.length}（${pct(unevidenced.length)}）`);
  return { injected: injected.length, unevidenced: unevidenced.length, total: ok.length };
}

const unrelated = await run('与库无关的查询', UNRELATED);
const related = await run('与库相关的查询（对照）', RELATED);

console.log(`\n结论：无关查询注入率 ${unrelated.injected}/${unrelated.total}，其中零证据注入 ${unrelated.unevidenced}/${unrelated.total}；`
  + `相关查询注入率 ${related.injected}/${related.total}。`);
console.log('若无关与相关两组的注入率接近，说明当前的选择层不能区分"有东西相关"与"只能给点东西"。');
