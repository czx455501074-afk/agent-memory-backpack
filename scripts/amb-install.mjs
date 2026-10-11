// 一键安装：只做已经被验证过的部分，未验证的部分如实打印人工步骤。
//
// 明确的能力边界（不要放宽）：
//   - DSH 与 Codex 桌面的「加载插件 + 信任 hooks」尚未验证通过。本脚本绝不声称
//     桌面已接入，也绝不替用户点信任。
//   - 凭据只打印路径，永不打印值。
//   - 所有状态判定读文件系统，不读环境变量假装检测。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = [
  'Agent Memory Backpack 本地安装脚本',
  '',
  '用法：node scripts/amb-install.mjs [选项]',
  '',
  '选项：',
  '  --data-dir DIR          数据目录（默认取核心的 defaultDataDir()，即 ~/.agent-memory-backpack）',
  '  --project ID            初始化写入的项目 ID（不传则沿用 cli init 的默认值）',
  '  --project-root PATH     适配器绑定的项目根（默认本仓库根目录）',
  '  --port N                核心监听端口（不传则沿用 cli init 的默认值 47631）',
  '  --admin-dir DIR         管理凭据单独存放目录（传给 cli init）',
  '  --build                 强制重新构建（默认仅在缺少 dist/src/cli.js 时构建）',
  '  --no-sync               跳过「同步本地已有知识」这一步（默认会同步）',
  '  --sync-roots PATH,...   只扫描这些位置（默认扫描 DSH/Codex 的规范与技能目录）',
  '  --codex-workspace PATH  用官方 codex CLI 把本插件装进该工作区（可选）',
  '  --start                 前台启动核心（cli serve），Ctrl+C 停止；默认不启动',
  '  --offline               自检跳过网络探测（等价于 cli doctor --offline）',
  '  --dry-run               只打印将要执行的命令，不创建目录、不构建、不安装',
  '  -h, --help              显示本帮助',
  '',
  '本脚本不做的事（重要，别把它当成「一键装好」）：',
  '  - 不安装、不信任任何桌面的 hooks。两端桌面的「加载插件 + 信任 hooks」尚未',
  '    验证通过，脚本只打印可执行的人工步骤。',
  '  - 不写任何凭据值到输出或日志，只打印凭据文件的路径。',
].join('\n');

// --help 在 parseArgs 之前处理：未知选项抛栈不是对 help 请求的好回答。
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
      'data-dir': { type: 'string' }, project: { type: 'string' },
      'project-root': { type: 'string' }, port: { type: 'string' },
      'admin-dir': { type: 'string' }, build: { type: 'boolean', default: false },
      'no-sync': { type: 'boolean', default: false }, 'sync-roots': { type: 'string' },
      'codex-workspace': { type: 'string' }, start: { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
    },
  }));
} catch (error) {
  console.error(`选项无法解析：${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  process.exit(1);
}

const dryRun = values['dry-run'] === true;
const cliPath = join(root, 'dist', 'src', 'cli.js');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const say = message => console.log(message);
const step = (index, total, title) => console.log(`\n[${index}/${total}] ${title}`);
const fail = message => { console.error(`错误：${message}`); process.exitCode = 1; };

/** 运行一个前台子进程并把它的输出原样交给用户；返回退出码。 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) return { status: 1, error: result.error.message };
  return { status: result.status ?? 1 };
}

/** npm 的调用方式：经由 npm 运行时用 npm_execpath，直跑 node 时退回 npm 可执行文件。 */
function npmCommand() {
  const exec = process.env.npm_execpath;
  if (exec && existsSync(exec) && exec.toLowerCase().endsWith('.js')) {
    return { command: process.execPath, prefix: [exec] };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };
}

function parseVersion(value) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(String(value).trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0), pre: match[4] ?? '' };
}

function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;      // 正式版高于同号预发布版
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** 真跑区间比较，支持空格分隔的 > >= < <= = 约束（engines.node 的实际写法）。 */
function satisfiesRange(version, range) {
  const actual = parseVersion(version);
  if (!actual) return { ok: false, reason: `当前版本「${version}」无法解析` };
  const tokens = String(range).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { ok: true, reason: '未声明约束' };
  for (const token of tokens) {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
    const target = parseVersion(match[2]);
    if (!target) return { ok: false, reason: `约束「${token}」无法解析` };
    const cmp = compareVersions(actual, target);
    const op = match[1] ?? '=';
    const passed = op === '>=' ? cmp >= 0 : op === '<=' ? cmp <= 0 : op === '>' ? cmp > 0 : op === '<' ? cmp < 0 : cmp === 0;
    if (!passed) return { ok: false, reason: `不满足约束「${token}」` };
  }
  return { ok: true, reason: '满足全部约束' };
}

/** 数据目录默认值只允许有一处定义：直接取构建产物里的 defaultDataDir()。 */
async function defaultDataDir() {
  const module = await import(pathToFileURL(join(root, 'dist', 'src', 'config.js')).href);
  return module.defaultDataDir();
}

/** 在 PATH 与 Codex 的已知安装位置里找 codex CLI；找不到返回 undefined。 */
function findCodexCli() {
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
  const candidates = [];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir) for (const name of names) candidates.push(join(dir, name));
  }
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const binRoot = join(localAppData, 'OpenAI', 'Codex', 'bin');
  if (existsSync(binRoot)) {
    try {
      for (const entry of readdirSync(binRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) for (const name of names) candidates.push(join(binRoot, entry.name, name));
      }
    } catch { /* 读不到就只依赖 PATH */ }
  }
  for (const candidate of candidates) {
    try { if (existsSync(candidate) && statSync(candidate).isFile()) return candidate; } catch { /* 跳过不可读项 */ }
  }
  return undefined;
}

const totalSteps = 7;
say('Agent Memory Backpack 本地安装');
say(`仓库根目录：${root}`);
if (dryRun) say('模式：--dry-run（只打印命令，不写入任何东西）');

// ---------------------------------------------------------------- [1/6] 环境
step(1, totalSteps, '环境前置检查');
const nodeVersion = process.versions.node;
const engineRange = manifest.engines?.node;
if (!engineRange) {
  say(`留意：package.json 未声明 engines.node，跳过 Node 版本检查（当前 ${nodeVersion}）。`);
} else {
  const verdict = satisfiesRange(nodeVersion, engineRange);
  if (!verdict.ok) {
    fail(`Node 版本不满足要求（${verdict.reason}）。`);
    console.error(`  当前版本：v${nodeVersion}`);
    console.error(`  要求区间：${engineRange}`);
    console.error('  怎么修：到 https://nodejs.org/dist/ 安装 24.13 及以上的 24.x 版本，');
    console.error('          或用 nvm-windows 执行 nvm install 24.19.0 && nvm use 24.19.0，');
    console.error('          装完重新打开终端，用 node --version 确认后重跑本脚本。');
    process.exit(1);
  }
  say(`Node v${nodeVersion} 满足 ${engineRange}（${verdict.reason}）。`);
}

// ---------------------------------------------------------------- [2/6] 构建
step(2, totalSteps, '构建检查');
const needBuild = values.build === true || !existsSync(cliPath);
if (!needBuild) {
  say(`已存在构建产物 ${cliPath}，跳过构建（需要重建时加 --build）。`);
} else if (dryRun) {
  const npm = npmCommand();
  say(`干跑：将执行 ${[npm.command, ...npm.prefix, 'run', 'build'].join(' ')}`);
} else {
  const npm = npmCommand();
  const args = [...npm.prefix, 'run', 'build'];
  say(`构建产物缺失或指定了 --build，执行：${npm.command} ${args.join(' ')}`);
  const result = run(npm.command, args, root);
  if (result.status !== 0) {
    fail(`构建失败，退出码 ${result.status}${result.error ? `（${result.error}）` : ''}。`);
    console.error('  上面是 tsc 的原始报错。修掉它之后重跑本脚本，或手动执行 npm run build。');
    process.exit(1);
  }
  if (!existsSync(cliPath)) {
    fail(`构建命令退出码为 0，但仍未生成 ${cliPath}，不要继续。`);
    console.error('  怎么修：检查 tsconfig.json 的 outDir 是否被改动。');
    process.exit(1);
  }
  say('构建完成。');
}

// ----------------------------------------------------------- [3/6] 数据目录
step(3, totalSteps, '初始化数据目录与凭据');
let dataDir;
try {
  dataDir = resolve(values['data-dir'] ?? await defaultDataDir());
} catch (error) {
  fail(`无法读取数据目录默认值：${error instanceof Error ? error.message : String(error)}`);
  console.error('  怎么修：先确保构建成功（npm run build），再用 --data-dir 显式指定目录。');
  process.exit(1);
}
const projectRoot = resolve(values['project-root'] ?? root);
const corePath = join(dataDir, 'core.json');
const clientPath = join(dataDir, 'client.json');
say(`数据目录：${dataDir}`);
say(`项目根（适配器绑定）：${projectRoot}`);

const initArgs = ['init', '--data-dir', dataDir, '--project-root', projectRoot];
if (values.project) initArgs.push('--project', values.project);
if (values.port) initArgs.push('--port', values.port);
if (values['admin-dir']) initArgs.push('--admin-dir', resolve(values['admin-dir']));
const initCommand = [process.execPath, cliPath, ...initArgs];

if (existsSync(corePath)) {
  // 幂等：已初始化就跳过，不覆盖凭据，也不碰已有配置。
  say('core.json 已存在，判定为已初始化，跳过初始化（不覆盖任何凭据），继续后续步骤。');
} else if (existsSync(clientPath)) {
  fail(`${dataDir} 里存在 client.json 但没有 core.json，cli init 会拒绝写入这种半成品状态。`);
  console.error('  怎么修：该目录可能是上一次中断留下的。人工确认后删除它，或改用 --data-dir 指向别的目录再重跑。');
  process.exit(1);
} else if (dryRun) {
  say(`干跑：将执行 ${initCommand.join(' ')}`);
} else {
  say(`执行 ${initCommand.join(' ')}`);
  const result = run(process.execPath, [cliPath, ...initArgs], root);
  if (result.status !== 0) {
    fail(`初始化失败，退出码 ${result.status}${result.error ? `（${result.error}）` : ''}。`);
    console.error('  上面是 cli init 的原始报错。目录不可写时先修权限，或改用 --data-dir 指向可写位置。');
    process.exit(1);
  }
  say('初始化完成。');
}

// ------------------------------------------------ 凭据位置（只打印路径，永不打印值）
const credentialFiles = ['core.json', 'client.json', 'codex-client.json', 'dsh-client.json', 'admin-client.json'];
say('凭据文件位置（只给路径，值一律不打印，不要提交或外发这些文件）：');
for (const name of credentialFiles) {
  const path = values['admin-dir'] && name === 'admin-client.json'
    ? join(resolve(values['admin-dir']), name)
    : join(dataDir, name);
  say(`  ${existsSync(path) ? '[存在]' : '[缺失]'} ${path}`);
}

// --------------------------------------------- [4/7] 同步本地已有知识（默认执行）
//
// 安装即同步，是用户明确要求的行为：装完插件就要能读到本机已有的规范和技能，
// 而不是让用户再手动跑一遍 discover/adopt。
//
// 两阶段且可撤销，因为「同步」会写库：
//   1. discover 只读，先看清会收进什么，原样打印给用户；
//   2. adopt 才写入，并打印撤销命令。
// 扫描对宿主只读，采纳只写插件自己的数据库，源文件不动。
step(4, totalSteps, '同步本地已有知识（discover → adopt）');
if (values['no-sync']) {
  say('传了 --no-sync，跳过。之后随时可以手动执行：');
  say(`  node dist/src/cli.js discover --data-dir "${dataDir}"`);
  say(`  node dist/src/cli.js adopt    --data-dir "${dataDir}" --yes`);
} else {
  const roots = values['sync-roots']
    ? String(values['sync-roots']).split(',').map(r => r.trim()).filter(Boolean)
    : null;
  const scopeArgs = roots ? ['--roots', roots.join(',')] : [];

  if (dryRun) {
    say(`干跑：将执行 discover（只读）${roots ? ` --roots ${roots.join(',')}` : '（默认扫描位置）'}`);
    say(`干跑：将执行 adopt --yes（写入插件数据库，可撤销）`);
  } else {
    // 先只读扫描。这一步无论如何都跑：即使后面采纳失败，用户也看得到发现了什么。
    say('--- 只读扫描（不写入任何内容）---');
    const scanned = run(process.execPath, [cliPath, 'discover', '--data-dir', dataDir, ...scopeArgs], root);
    if (scanned.status !== 0) {
      say('扫描未成功，跳过采纳。上面的报错是原始输出。');
      say(`  排查后可手动执行：node dist/src/cli.js discover --data-dir "${dataDir}"`);
    } else {
      say('');
      say('--- 采纳（写入插件数据库；源文件不会被改动）---');
      const adopted = run(process.execPath, [cliPath, 'adopt', '--data-dir', dataDir, ...scopeArgs, '--yes'], root);
      say('');
      if (adopted.status !== 0) {
        // 采纳失败不是安装失败：核心功能仍然可用，知识可以稍后再同步。
        say('采纳未成功。安装本身已完成，可稍后重试同步：');
        say(`  node dist/src/cli.js adopt --data-dir "${dataDir}" --yes`);
      } else {
        say('同步完成。撤销命令已在上面的输出里（adopt --revoke <时间戳>）。');
        say('说明：技能以原文保存并标记为「待结构化」，在有人给出结构之前不会被当作已核实流程。');
      }
    }
  }
}

// ------------------------------------------------- [5/7] Codex 插件（可选）
step(5, totalSteps, 'Codex 插件安装到工作区（可选）');
if (!values['codex-workspace']) {
  say('未传 --codex-workspace，跳过。需要时用法：');
  say('  node scripts/amb-install.mjs --codex-workspace <你准备用于验证的工作区绝对路径>');
} else {
  const workspace = resolve(values['codex-workspace']);
  const marketplacePath = join(workspace, '.agents', 'plugins', 'marketplace.json');
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    fail(`工作区不存在或不是目录：${workspace}`);
    console.error('  怎么修：先创建该目录，或用 scripts/prepare-desktop-p0.mjs 准备一个隔离测试工作区。');
  } else if (!existsSync(marketplacePath)) {
    fail(`该工作区没有本地 marketplace：${marketplacePath}`);
    console.error('  怎么修：先跑 npm run pack:local 产出安装包，再用 scripts/prepare-desktop-p0.mjs');
    console.error('          准备一个带 .agents/plugins/marketplace.json 的隔离工作区。');
  } else {
    // 名字从 marketplace 清单里读，不硬编码，避免与打包产物改名后脱节。
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
    const marketplaceName = marketplace.name;
    const pluginName = marketplace.plugins?.[0]?.name;
    const codex = findCodexCli();
    say(`工作区：${workspace}`);
    say(`marketplace：${marketplaceName}，插件：${pluginName}`);
    if (!pluginName || !marketplaceName) {
      fail('marketplace.json 里读不到 name 或 plugins[0].name，无法拼出安装选择器。');
    } else if (!codex) {
      // 找不到 CLI 不是失败：这一步骤本来就是可选的，人工路径仍然可用。
      say('未找到 codex CLI，跳过安装（不算失败）。');
      say('  人工步骤：先装 Codex CLI，再执行下面两条；或在 Codex 桌面里加载该 marketplace。');
      say(`    codex plugin marketplace add "${workspace}"`);
      say(`    codex plugin add ${pluginName}@${marketplaceName}`);
    } else {
      // 安装前备份目标 config；备份内容不打印，可能含密钥。
      const codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), '.codex');
      const userConfig = join(codexHome, 'config.toml');
      const workspaceConfig = join(workspace, '.codex', 'config.toml');
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
      const backupDir = join(codexHome, 'backups', `amb-install-${stamp}`);
      const commands = [
        [codex, 'plugin', 'marketplace', 'add', workspace],
        [codex, 'plugin', 'add', `${pluginName}@${marketplaceName}`],
      ];
      say(`codex CLI：${codex}`);
      if (dryRun) {
        say('干跑：不会执行任何安装，也不会写备份。将要执行的命令：');
        for (const command of commands) say(`  ${command.join(' ')}`);
        say(`  备份：${userConfig} -> ${join(backupDir, 'config.before-install.toml')}`);
        if (existsSync(workspaceConfig)) say(`  备份：${workspaceConfig} -> ${join(backupDir, 'workspace-config.before-install.toml')}`);
      } else {
        mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        const backed = [];
        for (const [source, name] of [[userConfig, 'config.before-install.toml'], [workspaceConfig, 'workspace-config.before-install.toml']]) {
          if (existsSync(source)) {
            const target = join(backupDir, name);
            // 只报告路径；备份正文可能含密钥，绝不打印。
            const { copyFileSync } = await import('node:fs');
            copyFileSync(source, target);
            backed.push(`${source} -> ${target}`);
          }
        }
        if (backed.length) {
          say('安装前已备份（内容不打印，可能含密钥。恢复就用这些文件覆盖回去）：');
          for (const line of backed) say(`  ${line}`);
        } else {
          say('没有可备份的 config 文件（此前不存在），跳过备份。');
        }
        for (const [command, ...args] of commands) {
          say(`执行 ${command} ${args.join(' ')}`);
          const result = run(command, args, workspace);
          if (result.status !== 0) {
            fail(`codex 命令失败，退出码 ${result.status}${result.error ? `（${result.error}）` : ''}。`);
            console.error('  上面是 codex CLI 的原始输出。要用备份回滚，把上面列出的备份文件覆盖回原路径。');
            break;
          }
        }
        say('CLI 侧安装流程结束。注意：CLI 安装成功不等于桌面接入通过（见末尾未验证说明）。');
      }
    }
  }
}

// ------------------------------------------------------- [6/7] 服务（可选）
step(6, totalSteps, '启动核心（可选）');
if (!values.start) {
  say('未传 --start，跳过。需要时：');
  say(`  node dist/src/cli.js serve --data-dir "${dataDir}"`);
  say('  这是前台进程，用 Ctrl+C 停止；P0 没有登录自启。');
} else if (dryRun) {
  say(`干跑：将执行 ${process.execPath} ${cliPath} serve --data-dir "${dataDir}"`);
}

// --------------------------------------------------------- [7/7] 自检
step(7, totalSteps, '自检（cli doctor）');
if (values.start) {
  say('提示：--start 会在自检之后占用前台，所以自检先跑。核心起来后可在另一个终端重跑 doctor 核对「核心可达」。');
}
const doctorArgs = ['doctor', '--data-dir', dataDir];
if (values.offline) doctorArgs.push('--offline');
if (dryRun) {
  say(`干跑：将执行 ${process.execPath} ${cliPath} ${doctorArgs.join(' ')}（跳过实际执行）`);
} else {
  say(`执行 ${process.execPath} ${cliPath} ${doctorArgs.join(' ')}`);
  say('');
  const result = run(process.execPath, [cliPath, ...doctorArgs], root);
  say('');
  // doctor 的失败项已经原样打在下面了，不吞。未启动核心时「核心可达」失败属预期。
  say(`自检退出码：${result.status}${result.status === 0 ? '（无阻塞问题）' : '（有失败项，见上面逐条建议）'}`);
  if (result.status !== 0 && !values.start) {
    say('  说明：未传 --start 时核心不在运行，「核心可达」失败是预期的，不代表安装失败。');
  }
}

// ------------------------------------------------------------- 未验证部分
say('\n================ 尚未验证的部分（不要当成已接入） ================');
say('两端桌面的「加载插件 + 信任 hooks」尚未验证通过。上面脚本做的都是本地已');
say('经验证的部分；下面这些必须人工在桌面 UI 里完成，且仍需自行探索：');
say('');
say('Codex 桌面：');
say(`  1. 打开工作区（不要用正在工作的仓库）：${values['codex-workspace'] ? resolve(values['codex-workspace']) : '<你准备用于验证的工作区>'}`);
say('  2. 通过本地 marketplace 加载插件，并在出现信任提示时审阅并信任 hooks。');
say('  3. 未信任状态不算接入通过。');
say('  已知卡点：官方文档给出的 /hooks 属于 codex CLI；桌面侧的信任入口本项目未能');
say('  确认，用户曾反馈找不到允许/信任入口。所以这一步不要凭猜测找，找不到就记录为未通过。');
say('');
say('DSH 桌面：');
say('  1. 设置 -> 插件，通过本地包入口加载打包产物里的 dsh-plugin 目录');
say('     （npm run pack:local 之后的 artifacts/p0-<时间戳>/dsh-plugin）。');
say('  2. 不要运行 dsh plugin --profile desktop，也不要手工重复 insert，包自带 bundle patch。');
say('  3. DSH 安装路径未验证，不能把 Codex 的 CLI 安装结果外推到 DSH。');

say('\n完成。安装凭据位于数据目录，路径已在上方列出；凭据值不会出现在任何输出里。');
if (dryRun) say('本次为 --dry-run，没有做任何写入。');
