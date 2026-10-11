import { existsSync, readFileSync, statSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { clientSchema, coreSchema } from './config.js';
import { capabilityManifest, operatingModeFromDisk } from './capabilities.js';
import { Logger } from './log.js';

/**
 * Self-check (`doctor`).
 *
 * Answers "why is this not working" without asking the user to reproduce
 * anything: configuration shape, credential validity, core reachability, data
 * directory writability, log health, and the host runtime version.
 *
 * Two deliberate properties:
 *
 *  - A check never throws. A failing check is a result, because a diagnostic
 *    tool that dies on the first problem is useless precisely when it is needed.
 *  - A credential is never printed. Presence and shape are reported, values are
 *    not, so the output is safe to paste into an issue.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  /** One line the user can act on. Never contains a credential. */
  detail: string;
  /** Suggested next step when the status is not `pass`. */
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: Check[];
  versions: Record<string, string>;
}
export interface DoctorOptions {
  dataDir: string;
  clientPath?: string;
  /** Skip the network probe; useful in tests and offline diagnosis. */
  offline?: boolean;
  fetchImpl?: typeof fetch;
  runtimeVersions?: Record<string, string>;
}

const pass = (id: string, title: string, detail: string): Check => ({ id, title, status: 'pass', detail });
const warn = (id: string, title: string, detail: string, hint?: string): Check => ({ id, title, status: 'warn', detail, hint });
const fail = (id: string, title: string, detail: string, hint?: string): Check => ({ id, title, status: 'fail', detail, hint });
const skip = (id: string, title: string, detail: string): Check => ({ id, title, status: 'skip', detail });

/**
 * Describe a credential without disclosing any of it.
 *
 * An earlier version printed the first four characters. That is not enough to
 * brute-force, but it is still part of the secret, and it made the documentation's
 * "the report holds no credential value" claim untrue. Length alone distinguishes
 * "configured and plausible" from "empty or truncated", which is the whole
 * diagnostic purpose.
 */
function describeCredential(token: string): string {
  if (token.length === 0) return 'empty';
  return `${token.length} characters; value not printed`;
}

function canWriteDirectory(dir: string): { ok: boolean; detail: string } {
  if (!existsSync(dir)) return { ok: false, detail: 'directory does not exist' };
  try {
    const info = statSync(dir);
    if (!info.isDirectory()) return { ok: false, detail: 'path exists but is not a directory' };
    accessSync(dir, constants.W_OK);
    return { ok: true, detail: 'writable' };
  } catch {
    return { ok: false, detail: 'not writable by this process' };
  }
}

/**
 * Run every check and return the findings.
 *
 * Order matters for readability: configuration first (everything else depends on
 * it), then storage, then the live core, then the host.
 */
export async function doctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: Check[] = [];
  const versions: Record<string, string> = { ...(options.runtimeVersions ?? {}) };
  const dataDir = resolve(options.dataDir);
  // An adapter's credential now lives under its own name in the shared data
  // directory. Falling back to a bare `client.json` keeps older installs working,
  // and a caller that names a path still wins.
  const clientPath = options.clientPath
    ?? (existsSync(join(dataDir, 'codex-client.json')) ? join(dataDir, 'codex-client.json') : join(dataDir, 'client.json'));

  versions.plugin = pluginVersion();

  // --- configuration -------------------------------------------------------
  let config;
  if (!existsSync(clientPath)) {
    checks.push(fail('client-config-present', '适配器配置存在', `未找到 ${clientPath}`,
      '先运行 cli init 生成配置，或设置 AMB_CONSOLE_CONFIG 指向已有的 client.json'));
  } else {
    checks.push(pass('client-config-present', '适配器配置存在', '已找到配置文件'));
    try {
      config = clientSchema.parse(JSON.parse(readFileSync(clientPath, 'utf8')));
      checks.push(pass('client-config-shape', '配置字段合法', `endpoint=${config.endpoint} projectId=${config.projectId}`));
      checks.push(pass('credential-shape', '凭据格式', describeCredential(config.token)));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unreadable';
      checks.push(fail('client-config-shape', '配置字段合法', `配置无法解析: ${message.slice(0, 200)}`,
        '重新运行 cli init，或修正 client.json 的字段'));
    }
  }

  const corePath = join(dataDir, 'core.json');
  if (existsSync(corePath)) {
    try {
      const core = coreSchema.parse(JSON.parse(readFileSync(corePath, 'utf8')));
      checks.push(pass('core-config-shape', '核心配置合法',
        `port=${core.port} 适配器=${core.clients.map(c => c.id).join('/')}`));
    } catch {
      checks.push(fail('core-config-shape', '核心配置合法', 'core.json 无法解析', '重新运行 cli init'));
    }
  } else {
    checks.push(warn('core-config-shape', '核心配置合法', `未找到 ${corePath}`,
      '只有适配器客户端时无法验证核心侧配置'));
  }

  // --- storage -------------------------------------------------------------
  const dirState = canWriteDirectory(dataDir);
  checks.push(dirState.ok
    ? pass('data-dir-writable', '数据目录可写', dataDir)
    : fail('data-dir-writable', '数据目录可写', `${dataDir}: ${dirState.detail}`,
      '检查目录权限，或改用 --data-dir 指向可写位置'));

  const database = join(dataDir, 'knowledge.sqlite');
  if (existsSync(database)) {
    checks.push(pass('database-present', '知识库存在', database));
  } else {
    checks.push(warn('database-present', '知识库存在', '尚未创建（首次运行后生成）'));
  }

  const logger = new Logger(dataDir);
  if (dirState.ok && !logger.isDegraded) {
    checks.push(pass('log-writable', '运行日志可写', logger.file));
  } else {
    checks.push(fail('log-writable', '运行日志可写', '日志目录不可写，问题将难以追溯',
      '修复数据目录写权限'));
  }

  // The adapter writes its own log, because when the core is unreachable that is
  // exactly when its record matters. Reporting it here keeps both logs visible
  // from one command.
  const pluginLog = join(dataDir, 'amb-plugin.log.jsonl');
  if (existsSync(pluginLog)) {
    try {
      const size = statSync(pluginLog).size;
      checks.push(pass('plugin-log-present', '插件运行日志', `${pluginLog}（${size} 字节）`));
    } catch {
      checks.push(warn('plugin-log-present', '插件运行日志', `${pluginLog} 存在但无法读取`, '检查文件权限'));
    }
  } else {
    checks.push(warn('plugin-log-present', '插件运行日志',
      '尚未生成（插件在宿主中加载后才会出现）',
      '在宿主中启用插件后重新运行自检'));
  }

  // --- live core -----------------------------------------------------------
  if (!config) {
    checks.push(skip('core-reachable', '核心可达', '缺少可用配置，未发起请求'));
    checks.push(skip('protocol-match', '协议版本匹配', '缺少可用配置，未发起请求'));
  } else if (options.offline) {
    checks.push(skip('core-reachable', '核心可达', '已按离线模式跳过'));
    checks.push(skip('protocol-match', '协议版本匹配', '已按离线模式跳过'));
  } else {
    const probe = options.fetchImpl ?? fetch;
    const started = Date.now();
    try {
      const response = await probe(new URL('/health', config.endpoint).href, { signal: AbortSignal.timeout(3000) });
      const elapsed = Date.now() - started;
      if (!response.ok) {
        checks.push(fail('core-reachable', '核心可达', `核心返回 HTTP ${response.status}（${elapsed}ms）`,
          '确认核心仍在运行；端口被占用时它会启动失败'));
      } else {
        const health = await response.json() as { protocolVersion?: unknown; phase?: unknown; status?: unknown };
        checks.push(pass('core-reachable', '核心可达', `回应正常（${elapsed}ms）`));
        if (health.protocolVersion === 1) {
          checks.push(pass('protocol-match', '协议版本匹配', `协议 v${String(health.protocolVersion)}，阶段 ${String(health.phase ?? 'unknown')}`));
        } else {
          checks.push(fail('protocol-match', '协议版本匹配', `核心协议为 ${String(health.protocolVersion)}，本插件需要 1`,
            '核心与插件版本不匹配，请同步更新两端'));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      checks.push(fail('core-reachable', '核心可达', `无法连接核心: ${message.slice(0, 120)}`,
        '先启动核心：node dist/src/cli.js serve --data-dir <目录>'));
      checks.push(skip('protocol-match', '协议版本匹配', '核心不可达，无法核对'));
    }
  }

  // --- operating mode -------------------------------------------------------
  //
  // Reported even when everything passes, because the mode is what tells a user
  // whether their rules are actually being enforced. A self-check that said only
  // "core OK" would leave the important question unanswered: if the core drops, do
  // the protections survive, and does the plugin say so?
  {
    const reachable = checks.some(check => check.id === 'core-reachable' && check.status === 'pass');
    const mode = operatingModeFromDisk(dataDir, reachable);
    const label = { Managed: '受核心实时裁决', ReadOnlySnapshot: '按快照只读执行', Ungoverned: '未受规则约束' }[mode.mode];
    checks.push({
      id: 'operating-mode',
      title: '运行模式',
      status: mode.mode === 'Managed' ? 'pass' : mode.mode === 'ReadOnlySnapshot' ? 'warn' : 'warn',
      detail: `${mode.mode}（${label}）— ${mode.detail}`,
      ...(mode.mode === 'Ungoverned'
        ? { hint: '核心不可达时不再阻断工具（这是有意的：一个可选知识服务不应锁死你的工作）。启动核心即可恢复 Managed：node dist/src/cli.js service start' }
        : {}),
    });
  }

  // --- adapter capabilities -------------------------------------------------
  //
  // Per the design, each end is marked separately and a shortfall is shown as a
  // downgrade rather than reported as full support. The list is generated from the
  // capability manifest rather than hand-written here, so the page and the CLI
  // cannot drift apart.
  {
    const manifest = capabilityManifest();
    for (const adapter of manifest) {
      const unmet = Object.entries(adapter.capabilities)
        .filter(([, state]) => state !== 'yes')
        .map(([name]) => name);
      const installedNote = adapter.installed
        ? `已安装${adapter.version ? ` ${adapter.version}` : ''}`
        : '未在该机器的已知位置找到已安装的包';
      checks.push({
        id: `capability-${adapter.id}`,
        title: `${adapter.id} 能力清单`,
        // Not a pass when something is missing: a capability gap is a fact about
        // the product, and marking it green would hide the one thing this list is for.
        status: unmet.length ? 'warn' : 'pass',
        detail: `${installedNote}；` + (unmet.length
          ? `不支持：${unmet.join('、')}`
          : '设计能力齐备'),
        ...(adapter.notes.length ? { hint: adapter.notes[0] } : {}),
      });
    }
  }

  // --- host runtime --------------------------------------------------------
  // Version checks are advisory on purpose: the plugin targets a range and
  // probes capabilities, so a newer host is reported, not rejected.
  const runtimeVersion = versions['@deepseek-ai/dsh-tools'];
  if (runtimeVersion) {
    const verdict = compareHostVersion(runtimeVersion);
    checks.push(verdict.status === 'pass'
      ? pass('host-runtime', '宿主运行时版本', verdict.detail)
      : warn('host-runtime', '宿主运行时版本', verdict.detail, verdict.hint));
  } else {
    checks.push(skip('host-runtime', '宿主运行时版本', '未提供宿主运行时版本（独立运行时可忽略）'));
  }

  const ok = !checks.some(check => check.status === 'fail');
  return { ok, checks, versions };
}

/**
 * The plugin's own version, read from its manifest.
 *
 * Two layouts must work: the repository (`dist/src/` → two levels up is the
 * package root) and the packaged artifact (`core/runtime/` → the manifest sits
 * beside `runtime/`). Probing both keeps the version informative in either place;
 * getting this wrong reports "unknown", which is exactly the field a user needs
 * when reporting a problem against a specific release.
 */
export function pluginVersion(): string {
  const candidates = [
    new URL('../../package.json', import.meta.url),   // repository: dist/src/
    new URL('../package.json', import.meta.url),      // artifact:  core/runtime/
  ];
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string; name?: string };
      if (manifest.version && manifest.name) return manifest.version;
    } catch { /* try the next layout */ }
  }
  return 'unknown';
}

/**
 * Compare the host runtime against the range this plugin was verified with.
 *
 * A version outside the range is a warning, never a failure: the plugin probes
 * for the capabilities it needs, so an older or newer host may well work. Only a
 * capability probe can decide, and that happens at load time.
 */
export function compareHostVersion(version: string, verified = '0.2.0-rc.2'): { status: CheckStatus; detail: string; hint?: string } {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(value.trim());
    return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), tag: match[4] ?? '' } : undefined;
  };
  const actual = parse(version);
  const expected = parse(verified);
  if (!actual || !expected) return { status: 'skip', detail: `无法比较版本：宿主 ${version}，已验证 ${verified}` };

  if (actual.major === expected.major && actual.minor === expected.minor && actual.patch === expected.patch && actual.tag === expected.tag) {
    return { status: 'pass', detail: `${version}（与已验证版本一致）` };
  }
  if (actual.major !== expected.major) {
    return {
      status: 'warn',
      detail: `宿主主版本为 ${version}，本插件验证过 ${verified}`,
      hint: '主版本差异较大，建议先跑一遍自检与真实任务确认；残缺能力会以明确错误暴露，不会静默降级',
    };
  }
  return {
    status: 'warn',
    detail: `宿主版本 ${version} 与已验证的 ${verified} 不同`,
    hint: '同主版本通常兼容；插件按能力探测，不按版本拒绝',
  };
}

/** One-line verdict for CLI output. */
export function summarizeDoctor(report: DoctorReport): string {
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of report.checks) counts[check.status] += 1;
  return `${report.ok ? 'OK' : 'PROBLEMS'}  pass=${counts.pass} warn=${counts.warn} fail=${counts.fail} skip=${counts.skip}`;
}
