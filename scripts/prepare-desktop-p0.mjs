// Prepare a reviewable, test-only desktop workspace. This does not install/trust
// plugins, edit either desktop profile, restart apps, or start a resident service.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { workspace: { type: 'string' }, 'data-dir': { type: 'string' } } });
const workspace = resolve(values.workspace ?? join(root, '.local/desktop-p0/workspace'));
const dataDir = resolve(values['data-dir'] ?? join(homedir(), '.agent-memory-backpack'));
const artifact = JSON.parse(readFileSync(join(root, 'artifacts/latest.json'), 'utf8')).directory;
if (existsSync(workspace) || existsSync(dataDir)) throw new Error('Workspace or data directory already exists; refusing to overwrite.');
const manifest = JSON.parse(readFileSync(join(artifact, 'artifact-manifest.json'), 'utf8'));
for (const [path, hash] of Object.entries(manifest.artifactFiles)) {
  const actual = createHash('sha256').update(readFileSync(join(artifact, path))).digest('hex');
  if (actual !== hash) throw new Error(`Artifact hash mismatch: ${path}`);
}
const run = (command, args, cwd = workspace) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Preparation command failed; preserve the partial fixture for diagnosis.');
};
mkdirSync(workspace, { recursive: true });
cpSync(artifact, join(workspace, 'packages'), { recursive: true });
mkdirSync(join(workspace, '.agents/plugins'), { recursive: true });
const marketplace = JSON.parse(readFileSync(join(artifact, '.agents/plugins/marketplace.json'), 'utf8'));
marketplace.plugins[0].source.path = './packages/codex-plugin';
writeFileSync(join(workspace, '.agents/plugins/marketplace.json'), JSON.stringify(marketplace, null, 2), { flag: 'wx' });
mkdirSync(join(workspace, '.codex'));
// No project-level `enabled = true` is written here on purpose.
//
// A fixture that pre-enables the plugin makes the "disable" acceptance step
// impossible to pass in Codex: the project setting outranks the global toggle, so
// turning the plugin off in the UI has no effect and the check fails for a reason
// the fixture created. The plugin is enabled from the desktop UI instead, which is
// both the realistic path and the one that can be reversed.
writeFileSync(join(workspace, '.codex/README.md'), [
  '# Codex 工作区说明',
  '',
  '本目录刻意不预置 `config.toml` 的插件启用项。',
  '',
  '`enabled = true` 会覆盖桌面 UI 的停用操作，使「停用后不再生效」这一验收项无法通过。',
  '请在 Codex 桌面中启用插件，并同样在那里停用以完成验收。',
  '',
].join('\n'), { flag: 'wx' });
writeFileSync(join(workspace, '.gitignore'), 'packages/\n', { flag: 'wx' });
run('git', ['init', '--quiet', workspace]);
const cli = join(workspace, 'packages/core/runtime/cli.js');
run(process.execPath, [cli, 'init', '--data-dir', dataDir, '--project', 'project-demo', '--project-root', workspace]);
run(process.execPath, [cli, 'seed', '--data-dir', dataDir, '--input', join(root, 'fixtures/p0-seed.json')]);
const quotePS = value => "'" + value.replaceAll("'", "''") + "'";
writeFileSync(join(workspace, 'start-core.ps1'),
  `$ErrorActionPreference = 'Stop'\n& ${quotePS(process.execPath)} ${quotePS(cli)} serve --data-dir ${quotePS(dataDir)}\n`, { flag: 'wx' });
writeFileSync(join(workspace, 'README.md'), `# Agent Memory Backpack P0 desktop fixture\n\nThis workspace contains only test knowledge. Desktop verification is pending.\n\nRun start-core.ps1 in a terminal and keep it open. Open this workspace in both desktop apps.\nCodex: load the Agent Memory Backpack P0 Local marketplace, review the hook definition before trusting it, then enable the plugin from the UI.\nDSH: use Settings > Plugins to install the local bundle at packages/dsh-plugin.\n\nEnable and disable the plugin from the desktop UI. This workspace deliberately\nwrites no project-level enabled flag, because that would outrank the UI toggle and\nmake the "disable" acceptance step impossible to pass.\n\nConfiguration: ${dataDir}\nSource artifact: ${artifact}\nDetailed procedure: ${join(root, 'docs/implementation/p0-desktop-runbook.md')}\n\nDo not copy credentials into chat. P0 MCP is pinned to project-demo and does not itself attest the caller cwd. Keep this plugin enabled only for this fixture.\n`, { flag: 'wx' });
writeFileSync(join(workspace, 'preparation.json'), JSON.stringify({ phase: 'P0', workspace, dataDir, sourceArtifact: artifact, desktopVerified: false, preparedAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
console.log(`Prepared desktop fixture: ${workspace}\nPrivate test configuration: ${dataDir}\nNo desktop installation, trust, restart, or background process was performed.`);
