import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { taskSchema } from '../src/schema.js';

// Two levels up: this file compiles to dist/test/.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const dshNaming = JSON.parse(
  readFileSync(join(repoRoot, 'adapters', 'dsh', 'dsh-plugin.naming.json'), 'utf8')
) as { names: { tools: string[] } };

const { toTaskRecord } = await import(
  pathToFileURL(join(repoRoot, 'adapters', 'dsh', 'index.mjs')).href
) as {
  toTaskRecord: (task: Record<string, unknown>, extraSessionId?: string) => Record<string, unknown>;
};
const { checkShellWriteBypass } = await import(
  pathToFileURL(join(repoRoot, 'adapters', 'dsh', 'gate-cache.mjs')).href
) as {
  checkShellWriteBypass: (toolName: string, command: string, deniedTools: string[]) => { denied: boolean; reason?: string };
};
const { checkNodeVersion } = await import(
  pathToFileURL(join(repoRoot, 'adapters', 'codex', 'scripts', 'node-version.mjs')).href
) as {
  checkNodeVersion: (version?: string) => { ok: boolean; version: string; error?: string };
};

test('BUG-H4: toTaskRecord 剥离服务端多余字段并产出符合 taskSchema 的有效载荷', () => {
  const listResultTask = {
    id: 'task-handoff-resume',
    projectId: 'proj-p0',
    title: '重构认证与会话接续',
    status: 'in_progress',
    summary: '已完成前半部分',
    notes: '注意上下文注入格式',
    knowledgeRevision: 5,
    unfinished: ['修复刷新令牌边界测试'],
    sessionIds: ['session-orig-1'],
    relatedExperiences: ['exp-auth-1'],
    relatedProposals: ['prop-1'],
    files: ['src/auth.ts'],
    fileStates: [{ path: 'src/auth.ts', digest: 'abc123' }],
    verified: '已核验基本路径',
    evidence: 'verifiable',
    startedAt: 1700000000,
    createdAt: 1699990000,
    updatedAt: 1700001000,
    completedAt: null,
  };

  const parsedDirect = taskSchema.safeParse(listResultTask);
  assert.equal(parsedDirect.success, false, '直接提交 tasks/list 返回的原始对象应被 strict schema 拒绝');

  const sanitized = toTaskRecord(listResultTask, 'session-new-2');
  const parsedSanitized = taskSchema.safeParse(sanitized);
  assert.equal(parsedSanitized.success, true, 'toTaskRecord 转换后的对象必须通过 taskSchema 校验');
  assert.deepEqual(sanitized.sessionIds, ['session-orig-1', 'session-new-2'], '应追加新的 session id');
  assert.equal('projectId' in sanitized, false, '服务端字段 projectId 必须被剥离');
  assert.equal('knowledgeRevision' in sanitized, false, '服务端字段 knowledgeRevision 必须被剥离');
  assert.equal('createdAt' in sanitized, false, '服务端字段 createdAt 必须被剥离');
  assert.equal('updatedAt' in sanitized, false, '服务端字段 updatedAt 必须被剥离');
  assert.equal('completedAt' in sanitized, false, '服务端字段 completedAt 必须被剥离');
});

test('BUG-H1: checkShellWriteBypass 拦截 shell 重定向与文件写入意图，且不误拦只读命令', () => {
  const deniedWrite = ['apply_patch', 'write', 'edit'];

  // Positive cases (must be denied)
  const writeCommands = [
    'printf "x" > notes.txt',
    'echo foo >> notes.txt',
    'cat file | tee notes.txt',
    'touch empty.txt',
    'mkdir -p output_dir',
    'Set-Content -Path notes.txt -Value test',
    'Out-File -FilePath notes.txt',
    'New-Item notes.txt -ItemType File',
    'dd if=/dev/zero of=swapfile bs=1M count=10',
  ];
  for (const cmd of writeCommands) {
    const res = checkShellWriteBypass('bash', cmd, deniedWrite);
    assert.equal(res.denied, true, `命令 "${cmd}" 必须被拦截`);
    assert.match(String(res.reason), /禁止文件写入/, '应给出明确的启发式拦截原因');
  }

  // Negative cases (must NOT be denied)
  const readOnlyCommands = [
    'cat notes.txt',
    'ls -la',
    'grep pattern file.txt',
    'grep foo bar > /dev/null',
    'grep foo bar 2>&1',
    'git status',
    'echo "just printing"',
  ];
  for (const cmd of readOnlyCommands) {
    const res = checkShellWriteBypass('bash', cmd, deniedWrite);
    assert.equal(res.denied, false, `只读命令 "${cmd}" 不得被误拦`);
  }

  // When write tools are NOT in deniedTools, shell commands proceed
  const resNoPolicy = checkShellWriteBypass('bash', 'echo "x" > notes.txt', ['read', 'grep']);
  assert.equal(resNoPolicy.denied, false, '未禁止写工具时 shell 重定向不得被拦截');

  // Non-shell tools are skipped by checkShellWriteBypass
  const resNonShell = checkShellWriteBypass('grep', 'echo "x" > notes.txt', deniedWrite);
  assert.equal(resNonShell.denied, false, '非 shell 工具不属于旁路拦截对象');
});

test('BUG-M4: DSH 适配器与 naming 清单均暴露 amb_search_universal', () => {
  assert.ok(dshNaming.names.tools.includes('amb_search_universal'), 'dsh-plugin.naming.json 必须包含 amb_search_universal');
  assert.equal(new Set(dshNaming.names.tools).size, dshNaming.names.tools.length, '命名清单不得有重复');
  const sorted = [...dshNaming.names.tools].sort();
  assert.deepEqual(dshNaming.names.tools, sorted, '命名清单应保持字母排序');
});

test('BUG-H5: checkNodeVersion 严格校验 Node 运行时区间 >=24.13.0 <25', () => {
  assert.equal(checkNodeVersion('20.19.2').ok, false, 'Node 20 必须被拒绝');
  assert.equal(checkNodeVersion('22.14.0').ok, false, 'Node 22 必须被拒绝');
  assert.equal(checkNodeVersion('24.12.9').ok, false, 'Node 24.12.9 必须被拒绝');
  assert.equal(checkNodeVersion('24.13.0').ok, true, 'Node 24.13.0 必须通过');
  assert.equal(checkNodeVersion('24.19.0').ok, true, 'Node 24.19.0 必须通过');
  assert.equal(checkNodeVersion('25.0.0').ok, false, 'Node 25.0.0 必须被拒绝');
  assert.equal(checkNodeVersion('invalid').ok, false, '无法解析版本必须被拒绝');
});
