/**
 * The Electron console is retired, and these are the guards that keep it retired.
 *
 * This file used to drive that panel itself: eight tests launched
 * `console/main.cjs`, rendered every panel against a real core, and probed the
 * tray's `HKCU\...\Run` login item. The surface those tests measured no longer
 * exists, so they are gone with it — a green copy of them would only assert that
 * a program nobody ships still starts.
 *
 * What has to hold instead is that the repository has exactly two product
 * surfaces: the Tauri desktop app and the DSH native panel. The retired Electron
 * tree is archived rather than deleted, and neither the packaging path nor the
 * deployment path mentions it any more.
 *
 * The deployment check is behavioural rather than textual. An artifact that
 * *does* contain a `console` tree is deployed, and the assertion is that the tree
 * is copied nowhere: that is the failure the cleanup exists to prevent, and a
 * source-text match would not catch it if the copy were re-added under another
 * spelling.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The repository root, found rather than assumed.
 *
 * This file runs from `test/` as TypeScript and from `dist/test/` once compiled,
 * so the number of levels to climb differs by one depending on which kind of test
 * is asking. Hard-coding either makes the guards below inspect the wrong tree.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = [resolve(here, '..'), resolve(here, '..', '..')].find(candidate =>
  existsSync(join(candidate, 'scripts', 'deploy-plugin.mjs'))) ?? resolve(here, '..', '..');

const RETIRED_CONSOLE = join(repoRoot, 'console');
const ARCHIVED_CONSOLE = join(repoRoot, 'console.archived-electron');
const PACKAGE = 'dsh-agent-memory-backpack';

test('Electron 控制台已归档：源码目录不再存在，归档保持可回滚', () => {
  assert.equal(existsSync(RETIRED_CONSOLE), false,
    'console/ 不得再出现在仓库根：它是弃用的 Electron 面板，不再是产品的一部分');
  // Deleting was explicitly refused: the archive is what makes the decision
  // reversible, so its absence is a failure, not a cleanup.
  assert.ok(existsSync(ARCHIVED_CONSOLE), '归档目录必须存在，否则这次弃用是不可逆的');
  for (const entry of ['main.cjs', 'preload.cjs', 'renderer/app.js', 'renderer/styles.css', 'assets/tray-icon.png']) {
    assert.ok(existsSync(join(ARCHIVED_CONSOLE, ...entry.split('/'))),
      `归档必须保留 ${entry}，否则无法还原被弃用的面板`);
  }
});

test('保留的两条产品线仍在位：Tauri 桌面与 DSH 内嵌面板', () => {
  // Product line A: the Tauri desktop app, tray and autostart included.
  const tauriConf = join(repoRoot, 'desktop-tauri', 'src-tauri', 'tauri.conf.json');
  assert.ok(existsSync(tauriConf), 'Tauri 是保留的面板，其配置必须存在');
  const conf = JSON.parse(readFileSync(tauriConf, 'utf8')) as { identifier?: unknown; productName?: unknown };
  assert.equal(typeof conf.identifier, 'string', 'Tauri 配置必须声明应用标识');
  assert.equal(typeof conf.productName, 'string', 'Tauri 配置必须声明产品名');
  assert.ok(existsSync(join(repoRoot, 'desktop-tauri', 'src-tauri', 'Cargo.toml')), 'Tauri 的 Rust 工程必须保留');

  // Product line B: the DSH native panel — browser half plus its host endpoints.
  assert.ok(existsSync(join(repoRoot, 'adapters', 'dsh', 'client.js')), 'DSH 内嵌面板的浏览器半必须保留');
  const host = readFileSync(join(repoRoot, 'adapters', 'dsh', 'index.mjs'), 'utf8');
  for (const endpoint of ['/amb/summary', '/amb/search', '/amb/task']) {
    assert.ok(host.includes(endpoint), `宿主侧数据端点 ${endpoint} 必须保留`);
  }
});

test('根 package.json 不再提供任何 Electron 入口，其它脚本原样保留', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  for (const retired of ['console', 'tray', 'icon:make', 'dist:console']) {
    assert.equal(retired in manifest.scripts, false,
      `脚本 ${retired} 只服务 Electron 面板，弃用后必须移除`);
  }
  for (const kept of ['build', 'check', 'test', 'start', 'doctor', 'logs',
    'accept:desktop', 'pack:local', 'deploy:plugin', 'install:local', 'uninstall:local']) {
    assert.ok(kept in manifest.scripts, `脚本 ${kept} 与 Electron 无关，必须保留`);
  }
});

test('打包脚本不再把 console 当作输入、产物或语法门目标', () => {
  const source = readFileSync(join(repoRoot, 'scripts', 'package.mjs'), 'utf8');

  // Positive assertions: each list that decides what ships is pinned, so
  // re-adding a console tree in any one of them fails here.
  assert.match(source, /for \(const folder of \['core', 'codex-plugin', 'dsh-plugin'\]\) addTree\(out, folder\);/,
    '哈希清单不得再遍历 console 树');
  assert.match(source, /for \(const folder of \['dist\/src', 'adapters\/codex', 'adapters\/dsh'\]\) addSourceTree\(folder\);/,
    '源码清单不得再遍历 console 树');
  assert.match(source, /for \(const folder of \['core', 'codex-plugin', 'dsh-plugin'\]\) syntaxCheck\(join\(out, folder\)\);/,
    '产物 node --check 门必须覆盖每一个真实产物目录');
  assert.equal(source.includes("['console', 'console']"), false,
    'copiedTreesVerified 不得再声明 console 复制对');
  assert.equal(/cpSync\(join\(root, 'console'\)/.test(source), false, '打包不得再复制 console 树');

  // The release-script syntax gate is the check that keeps a broken release
  // script from being discovered mid-release; it must survive the cleanup.
  assert.match(source, /releaseScripts[\s\S]{0,800}\['--check', file\]/, '发布脚本必须逐个通过 node --check');
});

/** An artifact that deliberately still contains the retired console tree. */
function buildArtifactWithConsole(dir: string): string {
  const artifact = join(dir, 'artifact');
  const plugin = join(artifact, 'dsh-plugin');
  mkdirSync(join(artifact, 'core', 'runtime'), { recursive: true });
  mkdirSync(join(artifact, 'console'), { recursive: true });
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, 'client.js'), 'globalThis.fixture = true;\n');
  writeFileSync(join(plugin, 'ensure-core.mjs'), 'export {};\n');
  writeFileSync(join(artifact, 'core', 'runtime', 'client.js'), 'export {};\n');
  writeFileSync(join(artifact, 'console', 'main.cjs'), '// retired electron entry\n');
  return artifact;
}

test('部署脚本对含 console 的产物也只部署 plugin 与 core', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amb-console-retired-'));
  const script = join(repoRoot, 'scripts', 'deploy-plugin.mjs');
  const target = join(dir, 'plugins', 'amb-plugin');
  const sibling = dirname(target);
  try {
    const artifact = buildArtifactWithConsole(dir);
    const home = join(dir, 'home');
    const profile = join(home, 'profiles', 'p1');
    mkdirSync(join(profile, 'node_modules'), { recursive: true });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      name: 'p1',
      dependencies: { [PACKAGE]: `link:${target}` },
      dsh: { profile: { bundles: [PACKAGE] } },
    }, null, 2));

    const result = spawnSync(process.execPath,
      [script, '--artifact', artifact, '--target', target, '--profiles', 'p1'], {
        encoding: 'utf8', windowsHide: true, cwd: repoRoot,
        env: { ...process.env, DSH_HOME: home, AMB_PLUGIN_DIR: target },
      });
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, `部署应当成功：${output}`);

    // The decisive property: a console tree present in the artifact reaches no
    // deployment destination.
    assert.equal(existsSync(join(sibling, 'console')), false,
      '产物里即使存在 console 树，也不得被部署到任何目标');
    assert.doesNotMatch(result.stdout, /(^|\n)console\s/, '部署报告不得再列出 console 目标');

    // Nor may the cleanup have broken what the deploy is for.
    assert.ok(existsSync(join(sibling, 'core')), 'core 目标必须照常部署');
    assert.ok(existsSync(join(target, 'ensure-core.mjs')), 'plugin 目标必须照常部署');
    assert.ok(existsSync(join(profile, 'node_modules', PACKAGE, 'ensure-core.mjs')),
      '经链接必须能读到插件内容，否则宿主加载不到');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
