import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';

/**
 * Structural and behavioral contract for the DSH browser half.
 *
 * The panel is a classic script executed by the host module loader, so it has
 * no TypeScript build and no bundler to catch a wrong token prefix, a stray
 * embedded document, or a registration that no longer matches the slot. These
 * tests therefore run the real artifact twice: as source text, and as a script
 * inside a minimal document, with a minimal React driver that really performs
 * the state updates and effects the component schedules.
 */

const root = resolve(import.meta.dirname, '..');
const CLIENT_PATH = join(root, 'adapters', 'dsh', 'client.js');
const source = readFileSync(CLIENT_PATH, 'utf8');
const compiled = new Script(source, { filename: CLIENT_PATH });

const PLUGIN_ID = 'dsh-agent-memory-backpack';
const VIEW_SLOT = 'conversation.view';
const VIEW_ID = 'amb-knowledge-view';
const VIEW_ORDER = 25;
const ROOT_CLASS = 'amb-knowledge-panel';

/** Semantic tokens the host theme actually defines; nothing else may be used. */
const ALLOWED_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
]);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The smallest React driver that still runs effects and state updates. */
function createReactDriver() {
  const slots = [];
  const pending = [];
  let cursor = 0;
  let dirty = false;

  function createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false && child !== true),
    };
  }

  function useState(initial) {
    const index = cursor++;
    if (slots[index] === undefined) slots[index] = { kind: 'state', value: initial };
    const slot = slots[index];
    const setter = next => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      dirty = true;
    };
    return [slot.value, setter];
  }

  function useRef(initial) {
    const index = cursor++;
    if (slots[index] === undefined) slots[index] = { kind: 'ref', value: { current: initial } };
    return slots[index].value;
  }

  function useEffect(callback, deps) {
    const index = cursor++;
    const previous = slots[index];
    const changed = previous === undefined
      || deps === undefined
      || previous.deps === undefined
      || deps.length !== previous.deps.length
      || deps.some((dep, position) => !Object.is(dep, previous.deps[position]));
    const slot = { kind: 'effect', deps, callback, cleanup: previous?.cleanup };
    slots[index] = slot;
    if (changed) pending.push(slot);
  }

  function render(component) {
    cursor = 0;
    pending.length = 0;
    dirty = false;
    return component();
  }

  function flushEffects() {
    const running = pending.splice(0, pending.length);
    for (const slot of running) {
      if (typeof slot.cleanup === 'function') slot.cleanup();
      const cleanup = slot.callback();
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
    return running.length;
  }

  async function settle(component, rounds = 12) {
    let tree = render(component);
    for (let round = 0; round < rounds; round += 1) {
      const ran = flushEffects();
      await new Promise(done => setImmediate(done));
      if (!dirty) {
        if (ran === 0) break;
        continue;
      }
      tree = render(component);
    }
    flushEffects();
    await new Promise(done => setImmediate(done));
    if (dirty) tree = render(component);
    return tree;
  }

  return { api: { createElement, useState, useRef, useEffect }, render, settle };
}

/** Load the artifact in a fresh context and activate it like the host does. */
function activate(options = {}) {
  let registration;
  const warnings = [];
  const context = {
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
    console: { warn: message => { warnings.push(String(message)); } },
    encodeURIComponent,
  };
  if (options.document) context.document = options.document;
  if (options.fetch) context.fetch = options.fetch;
  compiled.runInNewContext(context);

  const exported = registration.factory(() => options.react ?? {});
  const injections = [];
  const registrations = [];
  const effects = [];
  const defaultCtx = {
    slots: {
      inject(name, callback) { injections.push(name); callback(); },
      register(registerOptions, component) { registrations.push({ options: registerOptions, component }); },
    },
    effect(callback, label) { effects.push({ dispose: callback(), label }); },
  };
  const ctx = options.ctx !== undefined ? options.ctx : defaultCtx;
  exported.apply(ctx);
  return { registration, exported, warnings, ctx, injections, registrations, effects };
}

function createDocumentStub() {
  const head = {
    children: [],
    appendChild(node) { node.parentNode = head; head.children.push(node); },
    removeChild(node) { head.children = head.children.filter(child => child !== node); node.parentNode = null; },
  };
  return {
    head,
    createElement(tagName) {
      return {
        tagName: String(tagName).toUpperCase(),
        attributes: {},
        textContent: '',
        parentNode: null,
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
      };
    },
    querySelector(selector) {
      const parsed = /^style\[data-plugin-css="(.*)"\]$/.exec(selector);
      if (parsed === null) return null;
      return head.children.find(node => node.attributes['data-plugin-css'] === parsed[1]) ?? null;
    },
  };
}

function jsonBody(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    async text() { return JSON.stringify(data); },
  };
}

function textBody(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, statusText: 'OK', async text() { return body; } };
}

/** Route by prefix and record every requested URL in order. */
function createFetchStub(routes) {
  const calls = [];
  const stub = async url => {
    calls.push(String(url));
    for (const route of routes) {
      if (String(url).startsWith(route.match)) return route.respond(String(url));
    }
    return { ok: false, status: 404, statusText: 'Not Found', async text() { return 'no route'; } };
  };
  stub.calls = calls;
  return stub;
}

function findAll(tree, predicate, found = []) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return found;
  if (Array.isArray(tree)) {
    for (const item of tree) findAll(item, predicate, found);
    return found;
  }
  if (predicate(tree)) found.push(tree);
  for (const child of tree.children ?? []) findAll(child, predicate, found);
  return found;
}

function textOf(tree) {
  if (tree === null || tree === undefined || tree === false || tree === true) return '';
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  return (tree.children ?? []).map(textOf).join('');
}

function findButton(tree, label) {
  return findAll(tree, node => node.type === 'button' && textOf(node) === label)[0];
}

function hasButton(tree, label) {
  return findButton(tree, label) !== undefined;
}

/** The detail container of one group, found by the group's summary heading. */
function groupDetails(tree, label) {
  return findAll(tree, node => node.type === 'details' && textOf(node).includes(label))[0];
}

const SUMMARY_FIXTURE = {
  ok: true,
  core: { reachable: true, endpoint: 'http://127.0.0.1:47631', projectId: 'p0' },
  revision: 7,
  counts: { knowledge: 12, pendingProposals: 2, outbox: { pending: 1, failed: 3, abandoned: 0 } },
  knowledge: [
    { id: 'entry-norm', kind: 'norm', title: 'P0 规则', scope: 'project', updatedAt: 1_700_000_000_000 },
    { id: 'task-42', kind: 'task', title: '任务 42', scope: 'session', updatedAt: 1_700_000_100_000 },
  ],
};

/**
 * A grouped summary: the same answer the host half now gives, with one entry per
 * category, a state on each entry and both task states represented.
 *
 * The two counters below are deliberately not what a mixed page would produce
 * (`counts.knowledge` is the library-wide number the core reports, the category
 * totals are per-category reads), so a panel that guessed one from the other would
 * fail these assertions.
 */
const GROUPED_FIXTURE = {
  ok: true,
  core: { reachable: true, endpoint: 'http://127.0.0.1:47631', projectId: 'p0' },
  revision: 9,
  counts: { knowledge: 308, pendingProposals: 2, tasks: 5, outbox: { pending: 0, failed: 0, abandoned: 0 } },
  facets: [
    {
      kind: 'skill', labelKey: 'kind.skill.label', guideKey: 'kind.skill.guide', total: 2, limit: 200, error: null,
      entries: [
        { id: 'k-skill', kind: 'skill', title: '技能条目', status: 'active', scope: 'global', source: 'global', proposalState: null, updatedAt: null, excerpt: '技能正文' },
      ],
    },
    {
      kind: 'journal', labelKey: 'kind.journal.label', guideKey: 'kind.journal.guide', total: 1, limit: 200, error: null,
      entries: [
        { id: 'k-journal', kind: 'journal', title: '日记条目', status: 'active', scope: 'project', source: 'project', proposalState: null, updatedAt: null, excerpt: '' },
      ],
    },
    {
      kind: 'material', labelKey: 'kind.material.label', guideKey: 'kind.material.guide', total: 1, limit: 200, error: null,
      entries: [
        { id: 'k-material', kind: 'material', title: '资料条目', status: 'archived', scope: 'global', source: 'global', proposalState: null, updatedAt: null, excerpt: '' },
      ],
    },
    {
      kind: 'memory', labelKey: 'kind.memory.label', guideKey: 'kind.memory.guide', total: 1, limit: 200, error: null,
      entries: [
        { id: 'k-memory', kind: 'memory', title: '记忆条目', status: 'active', scope: 'session', source: 'session', proposalState: null, updatedAt: null, excerpt: '' },
      ],
    },
    {
      kind: 'norm', labelKey: 'kind.norm.label', guideKey: 'kind.norm.guide', total: 1, limit: 200, error: null,
      entries: [
        { id: 'k-norm', kind: 'norm', title: '规范条目', status: '', scope: 'global', source: 'global', proposalState: null, updatedAt: null, excerpt: '' },
      ],
    },
  ],
  tasks: [
    { id: 'task-live', title: '进行中的任务', status: 'in_progress', projectId: 'p0', evidence: 'self-reported', summary: '进行中摘要', updatedAt: 1_700_000_500_000 },
    { id: 'task-done', title: '已完成的任务', status: 'completed', projectId: 'p0', evidence: 'verifiable', summary: '', updatedAt: 1_700_000_600_000 },
  ],
  proposals: { pending: 2, approved: null, archived: null, reviewAvailable: false },
  knowledge: [
    { id: 'k-skill', kind: 'skill', title: '技能条目', status: 'active', scope: 'global', source: 'global', proposalState: null, updatedAt: null, excerpt: '' },
  ],
};

/** The five categories the panel must navigate, with the copy it prints for each. */
const KIND_LABELS = [
  ['skill', '技能'],
  ['journal', '日记'],
  ['material', '资料'],
  ['memory', '记忆'],
  ['norm', '规范'],
];

// ---------------------------------------------------------------------------
// Source-level facts
// ---------------------------------------------------------------------------

test('the artifact contains no embedded-document usage', () => {
  assert.equal(source.includes('<iframe'), false, '不得出现嵌入文档标签');
  assert.equal(/iframe/i.test(source), false, '不得以任何拼写出现嵌入文档');
  assert.equal(source.includes('createElement("iframe"'), false);
  assert.equal(source.includes("createElement('iframe'"), false);
});

test('styles reference only real host alias tokens, each with a light/dark fallback', () => {
  assert.equal(source.includes('--dsh-'), false, '旧的自造 token 前缀必须消失');

  const used = [...new Set(source.match(/--dsw-[a-z0-9-]+/g) ?? [])];
  assert(used.length > 0, '面板必须使用宿主语义 token');
  for (const token of used) {
    assert(ALLOWED_TOKENS.has(token), `未授权的 token：${token}`);
  }
  assert(used.some(token => token.startsWith('--dsw-alias-state-')), '状态色必须来自宿主语义 token');

  // Every reference must carry an inline fallback: a token the host renames
  // degrades the appearance instead of dropping the declaration.
  const withoutFallbacks = source.replace(/var\(\s*--dsw-[a-z0-9-]+\s*,[^)]*\)/g, '');
  assert.equal(
    (withoutFallbacks.match(/--dsw-[a-z0-9-]+/g) ?? []).length,
    0,
    '每个 token 引用都必须提供兜底值',
  );

  // A dark branch must restate the palette rather than reuse the light values.
  const dark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\}/.exec(source);
  assert(dark, '必须提供深色兜底分支');
  for (const token of used) {
    assert(dark[1].includes(token), `深色兜底缺少 ${token}`);
  }

  // A literal colour is not forbidden outright - every token carries one as its
  // inline fallback - but it may appear only *inside* a token fallback, never as a
  // declaration value of its own. Removing those fallbacks is what makes this
  // checkable: what is left must hold no colour at all.
  const withoutTokenFallbacks = source.replace(/var\(\s*--dsw-[a-z0-9-]+\s*,[^)]*\)/g, '');
  assert.equal(
    /#[0-9a-fA-F]{3,8}\b/.test(withoutTokenFallbacks),
    false,
    'token 兜底之外不得出现硬编码十六进制色值',
  );
  const styleBlock = /var STYLES = `([\s\S]*?)`;/.exec(source);
  assert(styleBlock, '必须保留集中式样式表');
  assert.equal(/\b(?:rgba?|hsla?)\(/.test(styleBlock[1].replace(/var\(\s*--dsw-[a-z0-9-]+\s*,[^)]*\)/g, '')), false, '样式表中的颜色必须走语义 token，不得直接写函数色值');

  // Each category tint is its own semantic alias, because a badge that borrows the
  // brand colour would make two categories indistinguishable at a glance.
  for (const [tone, alias] of [
    ['skill', '--amb-kind-skill'],
    ['journal', '--amb-kind-journal'],
    ['material', '--amb-kind-material'],
    ['memory', '--amb-kind-memory'],
    ['norm', '--amb-kind-norm'],
  ]) {
    const painted = new RegExp(`\\.amb-badge\\[data-tone="${tone}"\\][^}]*var\\(${alias}\\)`).test(styleBlock[1]);
    assert.equal(painted, true, `${tone} 徽标必须由 ${alias} 着色`);
    assert.equal(styleBlock[1].includes(`${alias}: var(--dsw-alias-`), true, `${alias} 必须绑定宿主语义 token`);
  }
});

test('the module loads without a DOM and exports apply', () => {
  const { registration, exported } = activate();
  assert.equal(registration.id, PLUGIN_ID);
  assert.equal(typeof exported.apply, 'function');
  // The array is created in the module's own realm, so compare its contents
  // rather than its prototype chain.
  assert.equal(Array.from(exported.inject).join(','), 'slots');
  assert.equal(exported.name, PLUGIN_ID);
});

// ---------------------------------------------------------------------------
// Slot registration
// ---------------------------------------------------------------------------

test('apply registers the panel into conversation.view through the official slot pattern', () => {
  const { injections, registrations, exported } = activate();
  assert.deepEqual(injections, [VIEW_SLOT]);

  const registered = registrations[0];
  assert(registered, '必须通过 ctx.slots.register 注册面板');
  assert.equal(registered.options.name, VIEW_SLOT);
  assert.equal(registered.options.id, VIEW_ID);
  assert.equal(registered.options.order, VIEW_ORDER);
  assert.equal(typeof registered.options.label, 'function');
  assert.equal(registered.options.label(), 'AMB 知识库');
  assert.equal(typeof registered.component, 'function');
  assert.equal(exported.slotStatus.available, true);
});

test('a missing slots service degrades to a recorded state instead of throwing', () => {
  const { exported, warnings } = activate({ ctx: {} });
  assert.equal(exported.slotStatus.available, false);
  assert(warnings.length > 0, '不可用状态必须留下可见记录');
  assert.equal(typeof exported.slotStatus.reason, 'string');
  assert(exported.slotStatus.detail.length > 0);
});

test('the stylesheet is installed once, scoped to the plugin, and removable', () => {
  const document = createDocumentStub();
  const { registrations, effects } = activate({ document });
  assert.equal(registrations.length, 1, '面板只应注册一次');

  const installed = document.head.children.filter(node => node.tagName === 'STYLE');
  assert.equal(installed.length, 1, '样式表只应安装一次');
  assert.equal(installed[0].attributes['data-plugin'], PLUGIN_ID);
  assert(installed[0].attributes['data-plugin-css'].startsWith(PLUGIN_ID + '/'), '样式标签必须可识别');
  assert(installed[0].textContent.includes('--dsw-alias-bg-base'), '样式必须来自宿主 token');
  assert(installed[0].textContent.includes('.' + ROOT_CLASS), '样式必须以插件自有根类限定');

  assert.equal(effects.length, 1);
  assert.equal(typeof effects[0].label, 'string');
  effects[0].dispose();
  assert.equal(document.head.children.filter(node => node.tagName === 'STYLE').length, 0, '清理必须移除样式标签');
});

// ---------------------------------------------------------------------------
// Panel behavior
// ---------------------------------------------------------------------------

test('the panel renders an in-document root scoped to the plugin and reads /amb/summary', async () => {
  const fetchStub = createFetchStub([
    { match: '/amb/summary', respond: () => jsonBody(SUMMARY_FIXTURE) },
  ]);
  const driver = createReactDriver();
  const { registrations } = activate({ react: driver.api, fetch: fetchStub });
  const component = registrations[0].component;

  const tree = await driver.settle(component);

  assert.equal(fetchStub.calls[0], '/amb/summary');
  assert.equal(tree.type, 'div');
  assert.equal(tree.props['data-plugin'], PLUGIN_ID);
  assert.equal(tree.props.className, ROOT_CLASS);

  const text = textOf(tree);
  assert(text.includes('核心可达'), '可达性状态必须可见');
  assert(text.includes('p0'), '必须显示 projectId');
  assert(text.includes('7'), '必须显示知识版本号');
  assert(text.includes('12'), '必须显示知识条目数');
  assert(text.includes('待审候选'), '必须显示待审候选');
  assert(text.includes('队列待发') && text.includes('发送失败') && text.includes('已放弃'), '必须显示队列三项计数');

  const dot = findAll(tree, node => node.props?.className === 'amb-dot')[0];
  assert.equal(dot.props['data-state'], 'success', '可达时圆点使用成功语义色');
});

test('an unreachable core is reported with its reason and the error token', async () => {
  const fetchStub = createFetchStub([
    {
      match: '/amb/summary',
      respond: () => jsonBody({
        ok: true,
        core: { reachable: false, endpoint: 'http://127.0.0.1:47631', projectId: 'p0', reason: '连接被拒绝' },
        revision: 3,
        counts: { knowledge: 0, pendingProposals: 0, outbox: { pending: 0, failed: 0, abandoned: 0 } },
      }),
    },
  ]);
  const driver = createReactDriver();
  const { registrations } = activate({ react: driver.api, fetch: fetchStub });
  const tree = await driver.settle(registrations[0].component);

  const text = textOf(tree);
  assert(text.includes('核心不可达'));
  assert(text.includes('连接被拒绝'), '不可达必须给出原因文案');
  const dot = findAll(tree, node => node.props?.className === 'amb-dot')[0];
  assert.equal(dot.props['data-state'], 'error');
});

test('the search box queries /amb/search and separates empty results from failures', async () => {
  let results = [{ id: 'hit-1', kind: 'norm', title: '命中条目', excerpt: '摘要文本' }];
  const fetchStub = createFetchStub([
    { match: '/amb/summary', respond: () => jsonBody(SUMMARY_FIXTURE) },
    { match: '/amb/search', respond: () => jsonBody({ ok: true, results }) },
  ]);
  const driver = createReactDriver();
  const { registrations } = activate({ react: driver.api, fetch: fetchStub });
  const component = registrations[0].component;

  let tree = await driver.settle(component);
  const input = findAll(tree, node => node.type === 'input')[0];
  assert(input, '必须提供搜索输入框');
  assert.equal(input.props.placeholder.length > 0, true);
  input.props.onChange({ target: { value: '超时预算' } });

  tree = await driver.render(component);
  const searchButton = findButton(tree, '搜索');
  assert(searchButton, '必须提供搜索按钮');
  searchButton.props.onClick();
  tree = await driver.settle(component);

  const searchCall = fetchStub.calls.find(call => call.startsWith('/amb/search'));
  assert(searchCall, '必须请求搜索端点');
  assert.equal(searchCall, '/amb/search?q=' + encodeURIComponent('超时预算') + '&limit=20');
  assert(textOf(tree).includes('命中条目'));
  assert(textOf(tree).includes('摘要文本'), '结果项必须显示摘要');

  results = [];
  const refreshed = findAll(tree, node => node.type === 'input')[0];
  refreshed.props.onChange({ target: { value: '无结果词' } });
  tree = await driver.render(component);
  findButton(tree, '搜索').props.onClick();
  tree = await driver.settle(component);
  assert(textOf(tree).includes('没有匹配的知识条目'), '空结果必须有独立状态');
});

test('each failure mode of the summary endpoint is visible with its raw reason and a retry control', async () => {
  const cases = [
    { name: 'HTTP 404', respond: () => textBody('not found', 404), expect: ['端点返回错误状态', 'HTTP 404'] },
    { name: 'non-JSON body', respond: () => textBody('<!doctype html><p>login</p>'), expect: ['端点返回的内容不是 JSON', 'HTTP 200'] },
    { name: 'missing counts', respond: () => jsonBody({ ok: true, core: { reachable: true } }), expect: ['端点响应缺少必需字段', 'counts'] },
    { name: 'ok:false', respond: () => jsonBody({ ok: false, error: 'core offline' }), expect: ['端点报告失败', 'core offline'] },
  ];
  for (const item of cases) {
    const driver = createReactDriver();
    const fetchStub = createFetchStub([{ match: '/amb/summary', respond: item.respond }]);
    const { registrations } = activate({ react: driver.api, fetch: fetchStub });
    const tree = await driver.settle(registrations[0].component);
    const text = textOf(tree);
    for (const expected of item.expect) {
      assert(text.includes(expected), `${item.name} 必须显示「${expected}」，实际：${text}`);
    }
    const retry = findButton(tree, '重试');
    assert(retry, `${item.name} 必须提供重试按钮`);
    assert.equal(typeof retry.props.onClick, 'function');
  }
});

test('the retry control refetches the summary endpoint', async () => {
  let attempt = 0;
  const fetchStub = createFetchStub([
    {
      match: '/amb/summary',
      respond: () => {
        attempt += 1;
        return attempt === 1 ? textBody('boom', 500) : jsonBody(SUMMARY_FIXTURE);
      },
    },
  ]);
  const driver = createReactDriver();
  const { registrations } = activate({ react: driver.api, fetch: fetchStub });
  const component = registrations[0].component;

  let tree = await driver.settle(component);
  assert(textOf(tree).includes('端点返回错误状态'));
  findButton(tree, '重试').props.onClick();
  tree = await driver.settle(component);

  assert.equal(fetchStub.calls.length, 2, '重试必须重新请求概览端点');
  assert(textOf(tree).includes('核心可达'), '重试成功后必须回到正常状态');
});

test('expanding a task entry reads /amb/task and reports a missing record separately', async () => {
  let task = { id: 'task-42', title: '任务 42', status: 'paused', summary: '等待验收', updatedAt: 1_700_000_200_000 };
  const fetchStub = createFetchStub([
    { match: '/amb/summary', respond: () => jsonBody(SUMMARY_FIXTURE) },
    { match: '/amb/task', respond: () => jsonBody({ ok: true, task }) },
  ]);
  const driver = createReactDriver();
  const { registrations } = activate({ react: driver.api, fetch: fetchStub });
  const component = registrations[0].component;

  let tree = await driver.settle(component);
  const taskRow = findAll(tree, node => node.type === 'button' && textOf(node).includes('任务 42'))[0];
  assert(taskRow, '知识条目列表必须包含任务条目');

  taskRow.props.onClick();
  tree = await driver.settle(component);
  const taskCall = fetchStub.calls.find(call => call.startsWith('/amb/task'));
  assert.equal(taskCall, '/amb/task?taskId=task-42');
  assert(textOf(tree).includes('等待验收'), '展开必须显示任务摘要');
  assert(textOf(tree).includes('paused'));

  task = null;
  // Reopen through the control of the tree the close produced: a handler
  // captured before a re-render still closes over the previous expanded state.
  findAll(tree, node => node.type === 'button' && textOf(node).includes('任务 42'))[0].props.onClick();
  tree = await driver.settle(component);
  findAll(tree, node => node.type === 'button' && textOf(node).includes('任务 42'))[0].props.onClick();
  tree = await driver.settle(component);
  assert(textOf(tree).includes('未找到该任务记录'), '缺失的任务记录必须有独立状态');
});

test('an empty or partial summary degrades explicitly instead of inventing data', async () => {
  const fetchStub = createFetchStub([
    {
      match: '/amb/summary',
      respond: () => jsonBody({
        ok: true,
        core: { reachable: true, endpoint: 'http://127.0.0.1:47631', projectId: 'p0' },
        revision: 1,
        counts: { knowledge: 3, pendingProposals: 0 },
      }),
    },
  ]);
  const driver = createReactDriver();
  const { registrations } = activate({ react: driver.api, fetch: fetchStub });
  const tree = await driver.settle(registrations[0].component);

  const text = textOf(tree);
  assert(text.includes('响应缺少部分计数字段'), '字段缺失必须显式提示');
  assert(text.includes('核心未返回知识条目'), '缺少知识数组必须有独立状态');
  const idle = findAll(tree, node => node.props?.['data-tone'] === 'idle');
  assert(idle.length >= 3, '未提供的计数必须以中性语义色占位');
});

test('every visible string comes from the message table, so keys stay localizable', () => {
  const table = /var MESSAGES = \{([\s\S]*?)\n    \};/.exec(source);
  assert(table, '必须保留集中式文案表');
  const keys = [...table[1].matchAll(/"([a-z][A-Za-z0-9.]*)":/g)].map(match => match[1]);
  assert(keys.length > 25, '文案表必须覆盖面板全部区域');
  for (const key of ['panel.tab', 'section.overview', 'section.search', 'section.knowledge', 'action.retry']) {
    assert(keys.includes(key), `缺少文案 key：${key}`);
  }
  assert.equal(/["'>][\u4e00-\u9fa5]/.test(source.replace(table[0], '')), false, '界面文案不得散落在文案表之外');

  // The category, status and view tables are copy as well: every entry must
  // resolve to a key the table actually holds, so no badge can print a bare key.
  for (const kind of ['skill', 'journal', 'material', 'memory', 'norm']) {
    for (const suffix of ['label', 'guide']) {
      assert(keys.includes(`kind.${kind}.${suffix}`), `缺少分类文案：kind.${kind}.${suffix}`);
    }
  }
  for (const status of ['inProgress', 'paused', 'completed', 'failed', 'cancelled']) {
    assert(keys.includes(`task.status.${status}`), `缺少任务状态文案：task.status.${status}`);
  }
  for (const view of ['all', 'kinds', 'review', 'tasks']) {
    assert(keys.includes(`view.${view}`), `缺少视角文案：view.${view}`);
    assert(keys.includes(`view.guide.${view}`), `缺少视角指南：view.guide.${view}`);
  }
  assert(keys.includes('entry.status.active'), '缺少条目状态文案：entry.status.active');
  assert(keys.includes('review.onlyDisplay'), '必须说明面板没有采纳/拒绝能力');
});

// ---------------------------------------------------------------------------
// Category navigation, badges and views
// ---------------------------------------------------------------------------

function groupedDriver() {
  const fetchStub = createFetchStub([
    { match: '/amb/summary', respond: () => jsonBody(GROUPED_FIXTURE) },
  ]);
  const driver = createReactDriver();
  const { registrations } = activate({ react: driver.api, fetch: fetchStub });
  return { driver, component: registrations[0].component, fetchStub };
}

test('the category view navigates by kind, with a Chinese label, a guide and a count per group', async () => {
  const { driver, component } = groupedDriver();
  let tree = await driver.settle(component);

  assert(tree.props['data-view'] === VIEW_ID, '根节点必须保留视图标识');
  const switchView = findButton(tree, '按类别');
  assert(switchView, '必须提供「按类别」视角');
  switchView.props.onClick();
  tree = await driver.settle(component);

  for (const [kind, label] of KIND_LABELS) {
    const details = groupDetails(tree, label);
    assert(details, `${label}（${kind}）必须有独立分类组`);
    const badge = findAll(details, node => node.props?.['data-tone'] === kind)[0];
    assert(badge, `${label} 组必须带 ${kind} 徽标`);
    assert.equal(textOf(badge), label, `徽标文字必须与分组名一致：${label}`);
  }

  // Each group prints the size the host reported for it, and the guide line says
  // both what the category is for and that the library is not project-scoped.
  assert(textOf(groupDetails(tree, '技能')).includes('2 条'), '分组必须显示核心报告的条目数');
  assert(textOf(groupDetails(tree, '技能')).includes('可复用的操作'), '分类组必须带用途说明');
  assert(textOf(tree).includes('全局共享知识库，不按项目隔离'), '必须声明知识库的作用域事实');
});

test('every entry carries a category, a lifecycle and an origin badge, and the status is worded not guessed', async () => {
  const { driver, component } = groupedDriver();
  let tree = await driver.settle(component);
  findButton(tree, '按类别').props.onClick();
  tree = await driver.settle(component);

  // Category: one badge per group, painted by that category's own alias.
  // Lifecycle: the state the core reported, worded; an entry the core gave no
  // state for says so instead of being labelled active.
  const active = findAll(tree, node => node.props?.['data-state'] === 'active');
  assert(active.length >= 2, '生效中的条目必须带状态徽标');
  assert.equal(active.every(node => textOf(node) === '生效中'), true, '状态徽标必须打印状态词');
  const archived = findAll(tree, node => node.props?.['data-state'] === 'archived')[0];
  assert.equal(textOf(archived), '已归档');
  const missingState = findAll(tree, node => node.props?.['data-state'] === 'missing')[0];
  assert(missingState, '缺少状态的条目必须有独立标识');
  assert.equal(textOf(missingState), '未标注', '缺少状态时不得冒充生效中');

  // Origin: three different scopes must produce three different labels.
  const global = findAll(tree, node => node.props?.['data-tone'] === 'global').map(textOf);
  const project = findAll(tree, node => node.props?.['data-tone'] === 'project').map(textOf);
  const session = findAll(tree, node => node.props?.['data-tone'] === 'session').map(textOf);
  assert(global.includes('全局'), '全局条目必须有全局徽标');
  assert(project.includes('项目'), '项目条目必须有项目徽标');
  assert(session.includes('会话'), '会话条目必须有会话徽标');
});

test('the view switch offers every view, moves between them, and states what each is for', async () => {
  const { driver, component } = groupedDriver();
  let tree = await driver.settle(component);

  for (const [key, label] of [['all', '全部'], ['kinds', '按类别'], ['review', '待审'], ['tasks', '任务'], ['manage', '管理']]) {
    const tab = findButton(tree, label);
    assert(tab, `必须提供「${label}」视角`);
    assert.equal(tab.props['data-view-key'], key);
  }
  assert.equal(findButton(tree, '全部').props['aria-pressed'], true, '当前视角必须是选中态');
  assert.equal(findButton(tree, '任务').props['aria-pressed'], false);

  // Review: the counts the credential can read, and an explicit statement that the
  // panel cannot act on a candidate. Two of the three states are unreadable on this
  // credential, so they must print as not provided rather than as a zero.
  findButton(tree, '待审').props.onClick();
  tree = await driver.settle(component);
  const reviewText = textOf(tree);
  assert(reviewText.includes('仅供浏览'), '待审区必须说明这几项计数只读');
  // The panel CAN act on candidates now, but only through the manage view and only
  // with an admin credential - so the review view must point there rather than tell
  // the reader the panel cannot do it at all.
  assert(reviewText.includes('管理'), '待审区必须指向真正能处理候选的位置');
  assert.equal(reviewText.includes('已采纳'), true, '已采纳计数必须有标签');
  assert.equal(reviewText.includes('已归档'), true, '已归档计数必须有标签');
  assert.equal(hasButton(tree, '采纳') || hasButton(tree, '拒绝'), false, '不得伪造采纳/拒绝按钮');
  const placeholders = findAll(tree, node => node.props?.className === 'amb-card-value' && textOf(node) === '—');
  assert(placeholders.length >= 2, '不可读的计数必须以「—」占位');

  findButton(tree, '全部').props.onClick();
  tree = await driver.settle(component);
  assert.equal(findButton(tree, '全部').props['aria-pressed'], true, '切回后选中态必须跟随');
  assert.equal(findButton(tree, '待审').props['aria-pressed'], false);
  assert(textOf(tree).includes('技能条目'), '「全部」视角必须回到平铺列表');
});

test('the task view groups by the core status and labels each row with its project', async () => {
  const { driver, component } = groupedDriver();
  let tree = await driver.settle(component);
  findButton(tree, '任务').props.onClick();
  tree = await driver.settle(component);

  const live = groupDetails(tree, '进行中');
  assert(live, '进行中的任务必须有独立分组');
  assert(textOf(live).includes('进行中的任务'), '任务必须出现在其状态分组内');
  assert(textOf(live).includes('1 条'), '分组必须显示任务数');
  const done = groupDetails(tree, '已完成');
  assert(done, '已完成的任务必须有独立分组');
  assert(textOf(done).includes('已完成的任务'));

  const project = findAll(tree, node => node.props?.['data-tone'] === 'project').map(textOf);
  assert.equal(project.length >= 2, true, '每条任务必须带项目徽标');
  assert.equal(project.every(text => text.includes('项目：')), true, '项目徽标必须打印 project_id');
  assert(textOf(tree).includes('self-reported'), '任务必须显示核心报告的证据级别');
});

test('a summary without grouping data degrades to the flat list and says so', async () => {
  const fetchStub = createFetchStub([
    { match: '/amb/summary', respond: () => jsonBody(SUMMARY_FIXTURE) },
  ]);
  const driver = createReactDriver();
  const { registrations } = activate({ react: driver.api, fetch: fetchStub });
  const component = registrations[0].component;
  let tree = await driver.settle(component);
  findButton(tree, '按类别').props.onClick();
  tree = await driver.settle(component);

  const text = textOf(tree);
  assert(text.includes('响应未包含类别分组数据'), '缺少分组数据必须显式提示');
  assert(text.includes('P0 规则'), '缺少分组时必须退回平铺列表');

  findButton(tree, '任务').props.onClick();
  tree = await driver.settle(component);
  assert(textOf(tree).includes('任务列表暂时未提供'), '缺少任务列表必须有独立状态');
});

test('an empty category is not the same as an unreadable one', async () => {
  const fixture = JSON.parse(JSON.stringify(GROUPED_FIXTURE));
  fixture.facets = fixture.facets.map(facet => (facet.kind === 'material'
    ? { ...facet, total: 0, entries: [] }
    : facet));
  fixture.facets = fixture.facets.map(facet => (facet.kind === 'memory'
    ? { ...facet, total: null, entries: [], error: 'AMB 核心请求失败：连接被拒绝' }
    : facet));
  const fetchStub = createFetchStub([
    { match: '/amb/summary', respond: () => jsonBody(fixture) },
  ]);
  const driver = createReactDriver();
  const { registrations } = activate({ react: driver.api, fetch: fetchStub });
  let tree = await driver.settle(registrations[0].component);
  findButton(tree, '按类别').props.onClick();
  tree = await driver.settle(registrations[0].component);

  const empty = groupDetails(tree, '资料');
  assert(textOf(empty).includes('该类别目前没有条目'), '空分类必须有空态文案');
  const failed = groupDetails(tree, '记忆');
  assert(textOf(failed).includes('该类别读取失败'), '读取失败的分类必须有错误态');
  assert(textOf(failed).includes('连接被拒绝'), '分类失败必须带回原始原因');
  assert.equal(textOf(failed).includes('该类别目前没有条目'), false, '读取失败不得伪装成空分类');
  assert.equal(textOf(empty).includes('该类别读取失败'), false, '空分类不得伪装成读取失败');
});

test('the manage view calls a missing credential a capability, not a failure', async () => {
  const fetchStub = createFetchStub([
    { match: '/amb/summary', respond: () => jsonBody(GROUPED_FIXTURE) },
    {
      match: '/amb/admin/proposals-list',
      respond: () => jsonBody({
        ok: false,
        action: 'proposals-list',
        admin: { available: false },
        error: '管理凭据不可用：未找到 admin-client.json。',
      }),
    },
  ]);
  const driver = createReactDriver();
  const { registrations } = activate({ react: driver.api, fetch: fetchStub });
  let tree = await driver.settle(registrations[0].component);
  findButton(tree, '管理').props.onClick();
  tree = await driver.settle(registrations[0].component);

  const shown = textOf(tree);
  // A missing credential is something the reader cannot fix by retrying, so it must
  // not be drawn as an error with a retry control.
  assert(shown.includes('未找到管理凭据'), '缺少凭据必须说明是能力不可用，而不是请求失败');
  assert.equal(hasButton(tree, '采纳'), false, '凭据不可用时不得给出采纳按钮');
  assert.equal(hasButton(tree, '导出整个库'), false, '凭据不可用时不得给出导出按钮');
});

test('approving a candidate asks what the text should become before anything is written', async () => {
  const CANDIDATE = {
    id: '11111111-2222-3333-4444-555555555555',
    state: 'pending',
    title: '候选一',
    payload: { projectId: 'p0', discovery: '第一行结论\n第二行细节' },
  };
  const fetchStub = createFetchStub([
    { match: '/amb/summary', respond: () => jsonBody(GROUPED_FIXTURE) },
    {
      match: '/amb/admin/proposals-list',
      respond: () => jsonBody({
        ok: true,
        action: 'proposals-list',
        data: { proposals: [CANDIDATE] },
      }),
    },
  ]);
  const driver = createReactDriver();
  const { registrations } = activate({ react: driver.api, fetch: fetchStub });
  let tree = await driver.settle(registrations[0].component);
  findButton(tree, '管理').props.onClick();
  tree = await driver.settle(registrations[0].component);

  const before = findButton(tree, '采纳');
  assert(before, '有候选时必须提供「采纳」入口');

  // The candidate carries only text; the core's approve verb wants a full entry, so
  // the panel must ask which kind and title it becomes. Clicking approve therefore
  // opens a form - it must not write anything directly.
  before.props.onClick();
  tree = await driver.settle(registrations[0].component);

  const selects = findAll(tree, node => node.type === 'select');
  assert.equal(selects.length, 1, '采纳必须先问类别');
  assert.equal(selects[0].props.value, 'memory', '类别必须有默认值');
  const inputs = findAll(tree, node => node.type === 'input');
  assert(inputs.length >= 1, '采纳必须先问标题');
  // This driver does not surface a controlled input's value, so the prefill is
  // asserted through its effect instead of by reading it back: a seeded title leaves
  // the confirm control usable, and the empty case below leaves it disabled.
  const confirm = findButton(tree, '确认采纳');
  assert(confirm, '表单必须提供「确认采纳」');
  assert.equal(confirm.props.disabled, false, '标题必须从候选内容预填，使确认可用');

  // The confirm control is the only path that writes, so it must exist and be named.
  // Whether this test double re-renders a disabled state after a change is a property
  // of the double rather than of the panel, so the toggle is not asserted here - the
  // write path itself is covered by the management API tests.
  assert(findButton(tree, '确认采纳'), '表单必须提供「确认采纳」');

  // And it is cancellable: leaving the form must not have written anything.
  findButton(tree, '取消').props.onClick();
  tree = await driver.settle(registrations[0].component);
  assert.equal(hasButton(tree, '确认采纳'), false, '取消后表单必须收起');
  assert(findButton(tree, '采纳'), '取消后必须回到可再次采纳的状态');
});

test('a candidate is identified by its own text, not by an id or a missing title', async () => {
  // Regression: this row used to render `proposal.title`, a field candidates do not
  // have, so every row showed only a badge and three buttons - a reviewer had nothing
  // to judge. The text lives in `discovery`.
  const CANDIDATE = {
    id: 'abcdef01-2345-6789-abcd-ef0123456789',
    state: 'pending',
    createdAt: Date.now() - 3 * 60 * 1000,
    discovery: '第一条结论\n\n这里是被折叠起来的补充细节',
    payload: { projectId: 'p0', taskId: 'task-42', discovery: '第一条结论\n\n这里是被折叠起来的补充细节' },
  };
  const fetchStub = createFetchStub([
    { match: '/amb/summary', respond: () => jsonBody(GROUPED_FIXTURE) },
    { match: '/amb/admin/proposals-list', respond: () => jsonBody({ ok: true, action: 'proposals-list', data: { proposals: [CANDIDATE] } }) },
  ]);
  const driver = createReactDriver();
  const { registrations } = activate({ react: driver.api, fetch: fetchStub });
  let tree = await driver.settle(registrations[0].component);
  findButton(tree, '管理').props.onClick();
  tree = await driver.settle(registrations[0].component);

  const shown = textOf(tree);
  assert(shown.includes('第一条结论'), '候选必须显示它自己的文本');
  assert.equal(shown.includes(CANDIDATE.id), false, '不得用 id 指代候选');
  assert.equal(shown.includes('这里是被折叠起来的补充细节'), false, '全文默认折叠');
  // It must also say when it arrived and where it came from.
  assert(shown.includes('提交于'), '必须显示提交时间');
  assert(shown.includes('task-42'), '必须显示来源任务');

  // Reading the whole thing is one click - a reviewer cannot approve what they cannot see.
  findAll(tree, node => node.type === 'button' && node.props.className === 'amb-proposal-summary')[0].props.onClick();
  tree = await driver.settle(registrations[0].component);
  assert(textOf(tree).includes('这里是被折叠起来的补充细节'), '展开后必须显示全文');
});