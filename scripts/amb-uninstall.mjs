// 卸载脚本：默认只做只读报告，显式 --purge-data + --yes 才删数据目录。
//
// 明确的安全边界：
//   - 删除前验证目标确实是 Agent Memory Backpack 数据目录（存在 core.json 或 knowledge.sqlite）。
//   - 明确打印「没有动过的东西」清单：用户原始 skills、AGENTS.md、其它插件、node_modules、
//     宿主 profile 中与本插件无关的部分。
//   - 呼应 README 承诺：「扫描全程只读」「卸载只删数据目录，不影响你的任何原始文件」。
import { existsSync, rmSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = [
  'Agent Memory Backpack 卸载脚本',
  '',
  '用法：node scripts/amb-uninstall.mjs [选项]',
  '',
  '选项：',
  '  --data-dir DIR          数据目录（默认取核心的 defaultDataDir()，即 ~/.agent-memory-backpack）',
  '  --purge-data            删除数据目录（要求二次确认 --yes；不传则只做只读报告）',
  '  --codex-workspace PATH  从该 Codex 工作区移除本插件（可选；会先备份 config）',
  '  --yes                   确认删除（与 --purge-data 配合）',
  '  -h, --help              显示本帮助',
  '',
  '默认行为（不传任何选项）：',
  '  只做只读报告，列出数据目录路径、凭据文件、以及人工在桌面 UI 里操作的步骤。',
  '  什么都不删。',
  '',
  '删除数据目录的正确流程：',
  '  1. 先不带 --yes 干跑一次：node scripts/amb-uninstall.mjs --purge-data',
  '  2. 确认要删除的绝对路径确实是你的测试/废弃数据，而不是误指向其他目录',
  '  3. 再加 --yes 执行删除：node scripts/amb-uninstall.mjs --purge-data --yes',
  '',
  '安全边界：',
  '  - 只删除明确是 Agent Memory Backpack 的数据目录（存在 core.json 或 knowledge.sqlite）。',
  '  - 不动用户原始 skills 文件、AGENTS.md、其它插件、node_modules、宿主 profile。',
].join('\n');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

let values;
try {
  ({ values } = parseArgs({
    allowPositionals: false,
    options: {
      'data-dir': { type: 'string' },
      'purge-data': { type: 'boolean', default: false },
      'codex-workspace': { type: 'string' },
      yes: { type: 'boolean', default: false },
    },
  }));
} catch (error) {
  console.error(`选项无法解析：${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  process.exit(1);
}

const say = message => console.log(message);
const warn = message => console.warn(`警告：${message}`);
const fail = message => { console.error(`错误：${message}`); process.exitCode = 1; };

/** 数据目录默认值只允许有一处定义：直接取构建产物里的 defaultDataDir()。 */
async function defaultDataDir() {
  const configPath = join(root, 'dist', 'src', 'config.js');
  if (!existsSync(configPath)) {
    throw new Error('dist/src/config.js 缺失；请先构建（npm run build）。');
  }
  const module = await import(pathToFileURL(configPath).href);
  return module.defaultDataDir();
}

/** 判定目录是否确实是 Agent Memory Backpack 数据目录：存在 core.json 或 knowledge.sqlite。 */
function isAmbDataDir(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  return existsSync(join(dir, 'core.json')) || existsSync(join(dir, 'knowledge.sqlite'));
}

/** 在 Codex 工作区 config 里查找本插件条目（按 marketplace 名称匹配）。 */
function findPluginInWorkspaceConfig(workspace) {
  const marketplacePath = join(workspace, '.agents', 'plugins', 'marketplace.json');
  const configPath = join(workspace, '.codex', 'config.toml');
  if (!existsSync(marketplacePath) || !existsSync(configPath)) return undefined;
  try {
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
    const marketplaceName = marketplace.name;
    const pluginName = marketplace.plugins?.[0]?.name;
    if (!marketplaceName || !pluginName) return undefined;
    const toml = readFileSync(configPath, 'utf8');
    const sectionPattern = new RegExp(`^\\[plugins\\."${pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@${marketplaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\]`, 'gm');
    return sectionPattern.test(toml) ? { pluginName, marketplaceName } : undefined;
  } catch {
    return undefined;
  }
}

say('Agent Memory Backpack 卸载');
say(`仓库根目录：${root}`);

let dataDir;
try {
  dataDir = resolve(values['data-dir'] ?? await defaultDataDir());
} catch (error) {
  fail(`无法读取数据目录默认值：${error instanceof Error ? error.message : String(error)}`);
  console.error('  怎么修：先确保构建成功（npm run build），再用 --data-dir 显式指定目录。');
  process.exit(1);
}

say(`\n目标数据目录：${dataDir}`);

if (!existsSync(dataDir)) {
  say('该目录不存在，无需卸载。');
  process.exit(0);
}

if (!isAmbDataDir(dataDir)) {
  fail('该目录不含 core.json 或 knowledge.sqlite，不是 Agent Memory Backpack 数据目录。');
  console.error('  怎么修：确认 --data-dir 指向的目录确实是你要卸载的测试数据目录；');
  console.error('          或不传该选项，使用默认值。出于安全考虑，本脚本拒绝删除不明目录。');
  process.exit(1);
}

// ------------------------------------------------------------ 只读报告部分
say('\n数据目录内容（只读检查）：');
const knownFiles = ['core.json', 'client.json', 'codex-client.json', 'dsh-client.json', 'admin-client.json', 'knowledge.sqlite', 'amb-plugin.log.jsonl', 'core.log.jsonl'];
let total = 0;
let listed = 0;
try {
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    const path = join(dataDir, entry.name);
    total += 1;
    if (knownFiles.includes(entry.name)) {
      const size = entry.isFile() ? ` (${statSync(path).size} 字节)` : '';
      say(`  [已知] ${entry.name}${size}`);
      listed += 1;
    } else if (listed < 10) {
      say(`  [其他] ${entry.name}`);
      listed += 1;
    }
  }
  if (total > listed) say(`  ... 以及其他 ${total - listed} 项（略）`);
} catch (error) {
  warn(`无法列举目录：${error instanceof Error ? error.message : String(error)}`);
}

// --------------------------------------------------- Codex 工作区检查（可选）
if (values['codex-workspace']) {
  const workspace = resolve(values['codex-workspace']);
  say(`\nCodex 工作区：${workspace}`);
  const found = findPluginInWorkspaceConfig(workspace);
  if (!found) {
    say('该工作区 config 里未找到本插件条目，无需移除（或已移除）。');
  } else {
    say(`检测到插件条目：${found.pluginName}@${found.marketplaceName}`);
    say('移除步骤（需手动执行）：');
    say('  1. 备份 .codex/config.toml（路径如下）；');
    say(`     ${join(workspace, '.codex', 'config.toml')}`);
    say(`  2. 执行 codex plugin remove ${found.pluginName}@${found.marketplaceName}`);
    say('  3. 确认移除后在 Codex 桌面新建会话，验证工具列表里不再有本插件的工具。');
    say('本脚本不会自动执行 codex plugin remove，避免误删或在 CLI 不可用时失败。');
  }
}

// -------------------------------------------------------- 人工步骤报告
say('\n人工在桌面 UI 里操作的步骤（本脚本不会自动做这些）：');
say('');
say('Codex 桌面：');
say('  - 在插件管理界面停用/卸载本插件。');
say('  - 或在工作区 .codex/config.toml 里移除 [plugins."<插件名>@<marketplace>"] 节。');
say('');
say('DSH 桌面：');
say('  - 设置 -> 插件，停用/卸载本插件。');
say('  - 不要直接删除 DSH 的 node_modules 或其他插件，只移除本插件即可。');
say('');

// -------------------------------------------------------- 数据目录删除（可选）
if (!values['purge-data']) {
  say('未传 --purge-data，数据目录保持原样（不删除任何东西）。');
  say('需要删除时：node scripts/amb-uninstall.mjs --purge-data --yes');
  process.exit(0);
}

say('\n准备删除数据目录：');
say(`  目标：${dataDir}`);
if (!values.yes) {
  warn('未传 --yes，只做干跑（不会真的删除）。');
  say('确认删除的步骤：');
  say('  1. 核对上面列出的绝对路径确实是你要删除的测试/废弃数据目录。');
  say('  2. 确认该目录里没有你需要保留的其他文件。');
  say('  3. 再加 --yes 执行：node scripts/amb-uninstall.mjs --purge-data --yes');
  process.exit(0);
}

say('开始删除（已确认 --yes）...');
try {
  rmSync(dataDir, { recursive: true, force: true });
  say(`已删除：${dataDir}`);
} catch (error) {
  fail(`删除失败：${error instanceof Error ? error.message : String(error)}`);
  console.error('  怎么修：检查目录权限，或有进程正在占用该目录（比如核心仍在运行）。');
  console.error('          先用 Ctrl+C 停止核心，或在任务管理器里结束 node.exe，再重试。');
  process.exit(1);
}

// -------------------------------------------------------- 明确说明未动的东西
say('\n卸载完成。下列内容未被触碰（按 README 承诺保持只读）：');
say('  - 你的原始 skills 文件（~/.agents/skills、~/.dsh/skills 等）');
say('  - 你的 AGENTS.md 或其他全局规范文件');
say('  - 其他插件的数据与配置');
say('  - 宿主 profile 中与本插件无关的部分');
say('  - 项目 node_modules 或其他依赖');
say('');
say('只删除了明确属于 Agent Memory Backpack 的数据目录，不影响你的任何原始文件。');
