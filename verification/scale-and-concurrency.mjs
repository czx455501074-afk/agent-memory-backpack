/**
 * 规模与并发：万级条目下的索引重建、检索延迟、重建期间的并发检索、两个进程同时写。
 *
 * 为什么单独一份：`npm test` 跑的是**正确性**，而这里量的是**在真实规模与真实并发下还成不成立**。
 * 前面几轮的修复都在小库（177 条）上验证过，但"177 条下很快"不等于"一万条下也能用"——
 * 尤其是术语桥：它把每条的别名与关键词都灌进全文索引，条目数一涨，索引体积与重建成本都会跟着涨。
 *
 * 与其他 `verification/` 脚本一致：**只读或只写临时目录、输出数字、不做断言、退出码恒 0**。
 * 唯一的例外是临时目录里的库，它用完即删，绝不碰真实数据目录。
 *
 * 用法：node verification/scale-and-concurrency.mjs [--entries 10000]
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Store } from '../dist/src/store.js';

const argIndex = process.argv.indexOf('--entries');
const ENTRIES = argIndex >= 0 ? Number(process.argv[argIndex + 1]) : 10000;
const CONCURRENCY = 20;

const root = mkdtempSync(join(tmpdir(), 'amb-scale-'));
const dbPath = join(root, 'knowledge.sqlite');
const report = { entries: ENTRIES, concurrency: CONCURRENCY };

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 造一份形状接近真实库的语料：正文长度参差，标题含中英混合与内部术语。 */
function corpus(count) {
  const rows = [];
  for (let index = 0; index < count; index++) {
    const topic = ['入库纪律', '检索链路', '术语桥', '分块读取', '部署回滚', '凭据脱敏'][index % 6];
    rows.push({
      id: `memory:scale-${index}`, baseRevision: 0, kind: 'memory',
      title: `${topic} ${index}（plugin / 插件）`,
      scope: { kind: 'global' },
      body: `${topic} 的第 ${index} 条记录。`.repeat(20 + (index % 60))
        + `\n相关工具：amb_read_knowledge、amb_search_universal。路径示例：D:\\projects\\p${index % 50}。`,
    });
  }
  return rows;
}

try {
  const store = new Store(dbPath, () => 1_000_000);

  // 1) 写入规模
  let writeStart = Date.now();
  for (let offset = 0; offset < ENTRIES; offset += 500) {
    store.import(corpus(500).map((row, index) => ({ ...row, id: `memory:scale-${offset + index}` })));
  }
  report.writeMs = Date.now() - writeStart;

  // 2) 索引重建（术语桥随之刷新 —— 这正是要量的一步）
  const rebuildStart = Date.now();
  report.indexRows = store.rebuildSearchIndex();
  report.rebuildMs = Date.now() - rebuildStart;

  // 3) 检索延迟：冷启动一次 + 取样
  const queries = ['术语桥', '入库纪律', 'amb_read_knowledge', '分块读取 的 做法', 'plugin 插件', '不存在的东西xyz'];
  const searchMs = [];
  for (let round = 0; round < 30; round++) {
    const query = queries[round % queries.length];
    const start = Date.now();
    store.searchUniversal('p0-workflow', query, undefined, 5);
    searchMs.push(Date.now() - start);
  }
  report.searchMedianMs = median(searchMs);
  report.searchMaxMs = Math.max(...searchMs);

  // 4) 注入延迟（每轮都会跑的那条路）
  const prepareMs = [];
  for (let round = 0; round < 10; round++) {
    const start = Date.now();
    store.prepare('p0-workflow', '术语桥与分块读取');
    prepareMs.push(Date.now() - start);
  }
  report.prepareMedianMs = median(prepareMs);
  report.prepareMaxMs = Math.max(...prepareMs);

  // 5) 并发：重建索引期间同时检索。SQLite 在写事务里会锁库，所以这里量的是"会不会报错/卡死"。
  const during = [];
  let duringErrors = 0;
  const rebuildPromise = new Promise(resolve => {
    setImmediate(() => {
      const start = Date.now();
      store.rebuildSearchIndex();
      report.concurrentRebuildMs = Date.now() - start;
      resolve();
    });
  });
  await Promise.all(Array.from({ length: CONCURRENCY }, async (_unused, index) => {
    try {
      const start = Date.now();
      store.searchUniversal('p0-workflow', queries[index % queries.length], undefined, 5);
      during.push(Date.now() - start);
    } catch { duringErrors++; }
  }).concat([rebuildPromise]));
  report.concurrentSearchCount = during.length;
  report.concurrentSearchErrors = duringErrors;
  report.concurrentSearchMaxMs = during.length ? Math.max(...during) : null;

  store.close();

  // 6) 多进程同时写：两个子进程各自 import 200 条。SQLite 允许多连接，但写事务会互相等。
  //    子进程里必须用 file:// URL：Windows 路径直接塞进 `import` 会报
  //    ERR_UNSUPPORTED_ESM_URL_SCHEME —— 我第一次跑就踩了这个，两个子进程全挂。
  const storeUrl = pathToFileURL(join(process.cwd(), 'dist', 'src', 'store.js')).href;
  const child = `
    import { Store } from ${JSON.stringify(storeUrl)};
    const store = new Store(${JSON.stringify(dbPath)}, () => 1_000_000);
    // tag 走环境变量：node -e 模式下 argv 的排布不可靠，第一版用 argv[2] 时两个进程都拿到
    // undefined，于是 id 撞车、第二个进程 200 条全报 "Revision changed" —— 那不是产品缺陷，
    // 是脚本没把参数传进去（而且乐观并发控制拦得对）。
    // 注意：这段代码本身在一个模板字符串里，所以注释里不能出现反引号 —— 会当场终止字符串，
    // 把后面的内容变成可执行代码（第一次这么写时报的是 "e is not defined"）。
    const tag = process.env.AMB_SCALE_TAG ?? 'x';
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: 'memory:multi-' + tag + '-' + i, baseRevision: 0, kind: 'memory',
      title: '并发写 ' + tag + ' ' + i, scope: { kind: 'global' }, body: '并发写入的正文。'.repeat(20),
    }));
    let ok = 0, failed = 0;
    for (const row of rows) {
      try { store.import([row]); ok++; } catch (error) { failed++; if (failed === 1) console.error(String(error.message).slice(0, 120)); }
    }
    store.close();
    console.log(JSON.stringify({ tag, ok, failed }));
  `;
  const runChild = tag => new Promise(resolve => {
    const childProcess = spawn(process.execPath, ['--input-type=module', '-e', child], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AMB_SCALE_TAG: tag },
    });
    let out = ''; let err = '';
    childProcess.stdout.on('data', chunk => { out += chunk; });
    childProcess.stderr.on('data', chunk => { err += chunk; });
    childProcess.on('close', code => {
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch { /* 解析失败也要保留 stderr */ }
      // stderr 一律带上：第一次跑时它被截到 200 字符、第二次又只在解析失败时才带上，
      // 两次都恰好丢掉了唯一能判断"可重试还是不可重试"的那行字。
      resolve({ ...(parsed ?? { tag, parseFailed: true }), exit: code, stderr: err.trim() || undefined });
    });
  });
  const multiStart = Date.now();
  report.multiProcess = await Promise.all([runChild('a'), runChild('b')]);
  report.multiProcessMs = Date.now() - multiStart;

  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ...report, fatal: String(error?.message ?? error).slice(0, 400) }, null, 2));
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄未释放不算结论 */ }
}
