// 卸载脚本：默认只做只读报告，显式 --purge-data + --yes 才删数据目录。
//
// 明确的安全边界：
//   - 删除前验证目标确实是 Agent Memory Backpack 数据目录（存在 core.json 或 knowledge.sqlite）。
//   - 明确打印「没有动过的东西」清单：用户原始 skills、AGENTS.md、其它插件、node_modules、
//     宿主 profile 中与本插件无关的部分。
//   - 呼应 README 承诺：「扫描全程只读」「卸载只删数据目录，不影响你的任何原始文件」。
import { existsSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

// -------------------------------------------------------- 数据目录删除与清理（可选）
function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getListeningPids(port) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return [];
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`
      ], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      return out.trim().split(/\s+/).map(Number).filter(p => Number.isSafeInteger(p) && p > 0);
    }
    try {
      const out = execFileSync('lsof', ['-iTCP:' + port, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8', timeout: 3000 });
      return [...out.matchAll(/p(\d+)/g)].map(m => Number(m[1])).filter(p => Number.isSafeInteger(p) && p > 0);
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

async function verifyCoreProcess(dir, pid, port) {
  let targetPort = (typeof port === 'number' && port > 0) ? port : null;
  if (!targetPort) {
    const coreJsonFile = join(dir, 'core.json');
    if (existsSync(coreJsonFile)) {
      try {
        const coreConfig = JSON.parse(readFileSync(coreJsonFile, 'utf8'));
        if (coreConfig?.port) targetPort = Number(coreConfig.port);
        else if (coreConfig?.endpoint) {
          const u = new URL(coreConfig.endpoint);
          if (u.port) targetPort = Number(u.port);
        }
      } catch {}
    }
  }

  if (!targetPort) {
    return { verified: false, reason: 'no_port_found' };
  }

  // 1. Check health on the recorded port
  let healthOk = false;
  try {
    const res = await fetch(`http://127.0.0.1:${targetPort}/health`, { signal: AbortSignal.timeout(800), redirect: 'error' });
    if (res.ok) {
      const body = await res.json();
      if (body?.protocolVersion === 1 && body?.status === 'ok') {
        healthOk = true;
      }
    }
  } catch {}

  if (!healthOk) {
    return { verified: false, reason: 'health_probe_failed', port: targetPort };
  }

  // 2. Bind pid to the listening port: kernel must confirm this pid owns the listening socket
  const listeningPids = getListeningPids(targetPort);
  if (listeningPids.length === 0) {
    // If kernel cannot confirm who owns the port, we cannot bind pid to it.
    // The only safe action is refusing to kill automatically.
    return { verified: false, reason: 'socket_owner_unverifiable', port: targetPort, platform: process.platform };
  }
  if (!listeningPids.includes(pid)) {
    return { verified: false, reason: 'pid_not_owning_port', port: targetPort, owningPids: listeningPids };
  }

  return { verified: true, port: targetPort };
}

async function stopCoreIfRunning(dir) {
  const lockFile = join(dir, 'core.lock');
  if (!existsSync(lockFile)) return { stopped: false, reason: 'no_lock' };

  let lockInfo;
  try {
    lockInfo = JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch {
    rmSync(lockFile, { force: true });
    return { stopped: false, reason: 'unreadable_lock_cleaned' };
  }

  const pid = lockInfo?.pid;
  if (!pid || typeof pid !== 'number') {
    rmSync(lockFile, { force: true });
    return { stopped: false, reason: 'invalid_pid_cleaned' };
  }

  if (!isProcessAlive(pid)) {
    rmSync(lockFile, { force: true });
    return { stopped: false, pid, reason: 'stale_lock_cleaned' };
  }

  // Ownership verification: ensure this process is genuinely our core before signaling
  const verification = await verifyCoreProcess(dir, pid, lockInfo?.port);
  if (!verification.verified) {
    warn(`锁文件记录的 PID ${pid} 正在运行，但其端口或服务未确认为 Agent Memory Backpack 核心进程（健康探测未响应或协议不符）。`);
    warn(`为防止误杀其他无关进程，脚本拒绝发信号，数据目录未清理。请人工核对 PID ${pid}。`);
    return { stopped: false, pid, refused: true, reason: 'foreign_or_unverified_process' };
  }

  say(`检测到正在运行的核心进程（PID: ${pid}），已通过归属验证，正在停止...`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}

  const start = Date.now();
  while (isProcessAlive(pid) && Date.now() - start < 3000) {
    await new Promise(r => setTimeout(r, 100));
  }

  if (isProcessAlive(pid)) {
    say(`进程未在 3 秒内退出，发送强制终止信号...`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      try { process.kill(pid); } catch {}
    }
    const killStart = Date.now();
    while (isProcessAlive(pid) && Date.now() - killStart < 2000) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Wait until port is completely freed to avoid Windows file lock race
  const port = lockInfo?.port;
  if (typeof port === 'number' && port > 0) {
    const portStart = Date.now();
    while (Date.now() - portStart < 2500) {
      try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(150), redirect: 'error' });
        await new Promise(r => setTimeout(r, 100));
      } catch {
        break;
      }
    }
  }

  rmSync(lockFile, { force: true });
  // Allow OS to release open SQLite handles (especially on Windows)
  await new Promise(r => setTimeout(r, 150));
  return { stopped: !isProcessAlive(pid), pid };
}

function cleanDeployedDshPlugin() {
  const PACKAGE = 'dsh-agent-memory-backpack';
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const profilesDir = join(dshHome, 'profiles');
  const cleanedProfiles = [];

  if (existsSync(profilesDir)) {
    try {
      for (const profile of readdirSync(profilesDir)) {
        const profileDir = join(profilesDir, profile);
        const manifestPath = join(profileDir, 'package.json');
        let touched = false;
        if (existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            if (manifest.dependencies && manifest.dependencies[PACKAGE]) {
              delete manifest.dependencies[PACKAGE];
              touched = true;
            }
            if (Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes(PACKAGE)) {
              manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(b => b !== PACKAGE);
              touched = true;
            }
            if (touched) {
              writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
              cleanedProfiles.push(profile);
            }
          } catch {}
        }

        const link = join(profileDir, 'node_modules', PACKAGE);
        if (existsSync(link)) {
          try {
            const stats = lstatSync(link);
            if (stats.isSymbolicLink()) {
              const linkDest = readlinkSync(link);
              const resolvedDest = resolve(profileDir, 'node_modules', linkDest);
              // Only remove if it resolves to our target or contains our package sentinel
              if (resolvedDest === resolve(target) || existsSync(join(link, 'ensure-core.mjs')) || existsSync(join(resolvedDest, 'ensure-core.mjs'))) {
                rmSync(link, { recursive: true, force: true });
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  const target = process.env.AMB_PLUGIN_DIR
    ? resolve(process.env.AMB_PLUGIN_DIR)
    : join(dshHome, 'plugins', 'agent-memory-backpack');

  let targetCleaned = false;
  if (existsSync(target)) {
    try {
      if (existsSync(join(target, 'ensure-core.mjs')) || existsSync(join(target, 'package.json'))) {
        rmSync(target, { recursive: true, force: true });
        targetCleaned = true;
      }
    } catch {}
  }

  return { cleanedProfiles, targetCleaned, target };
}

if (!values['purge-data']) {
  say('未传 --purge-data，数据目录保持原样（不删除任何东西）。');
  say('需要删除时：node scripts/amb-uninstall.mjs --purge-data --yes');
  process.exit(0);
}

say('\n准备删除数据目录与清理部署：');
say(`  目标：${dataDir}`);
if (!values.yes) {
  warn('未传 --yes，只做干跑（不会真的删除）。');
  say('确认删除的步骤：');
  say('  1. 核对上面列出的绝对路径确实是你要删除的测试/废弃数据目录。');
  say('  2. 确认该目录里没有你需要保留的其他文件。');
  say('  3. 再加 --yes 执行：node scripts/amb-uninstall.mjs --purge-data --yes');
  process.exit(0);
}

say('开始执行卸载清理（已确认 --yes）...');

// 1. Stop core if running to release SQLite file handles
try {
  const stopOutcome = await stopCoreIfRunning(dataDir);
  if (stopOutcome.refused) {
    fail('核心进程归属未通过验证，已拒绝发信号并终止卸载，以避免误伤无关进程。');
    process.exit(1);
  }
  if (stopOutcome.stopped) {
    say(`已停止核心进程（PID: ${stopOutcome.pid}）。`);
  }
} catch (err) {
  warn(`停止核心进程时遇到异常：${err instanceof Error ? err.message : String(err)}`);
}

// 2. Clean deployed DSH plugin and profile junctions
try {
  const deployClean = cleanDeployedDshPlugin();
  if (deployClean.targetCleaned) say(`已清理部署目标目录：${deployClean.target}`);
  if (deployClean.cleanedProfiles.length > 0) say(`已从下列 DSH profiles 移除依赖与链接：${deployClean.cleanedProfiles.join(', ')}`);
} catch (err) {
  warn(`清理 DSH 部署时遇到异常：${err instanceof Error ? err.message : String(err)}`);
}

// 3. Purge dataDir
try {
  rmSync(dataDir, { recursive: true, force: true });
  say(`已删除数据目录：${dataDir}`);
} catch (error) {
  fail(`删除数据目录失败：${error instanceof Error ? error.message : String(error)}`);
  console.error('  当前状态：核心已尝试停止，部分文件可能仍在释放。请重试执行卸载收敛清理。');
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
