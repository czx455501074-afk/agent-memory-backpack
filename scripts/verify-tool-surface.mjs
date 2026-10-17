// Cross-check the MCP tool surface against the core's admin-only set.
//
// Found the hard way: amb_structure_skill and amb_supersede_experience were visible to
// an agent, described like ordinary operations, and refused with 403 every time,
// because the endpoints they call are admin-only while an MCP client holds an adapter
// credential. Checking one suspicious pair by eye does not answer "are there others?",
// and the worse direction - a tool that an adapter CAN call but should not be able to -
// is the one nobody notices.
//
// Read-only: parses the two sources and reports. Nothing is called.
//
// Usage: node scripts/verify-tool-surface.mjs [--json]
// Exit code: 0 when no mismatches, 1 otherwise.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const asJson = process.argv.includes('--json');

const mcpSource = readFileSync(join(root, 'src/mcp.ts'), 'utf8');
const serverSource = readFileSync(join(root, 'src/server.ts'), 'utf8');

// --- tools -> endpoint ---------------------------------------------------
// Each registration is `registerTool('<name>', { ... }, args => call('<path>', ...))`,
// so split on the registration marker and take the first call() in each chunk.
const tools = [];
const chunks = mcpSource.split(/registerTool\(/).slice(1);
for (const chunk of chunks) {
  const name = /^'([^']+)'/.exec(chunk)?.[1];
  if (!name) continue;
  const endpoint = /call\('(\/v1\/[^']+)'/.exec(chunk)?.[1];
  const readOnly = /readOnlyHint:\s*true/.test(chunk.slice(0, chunk.indexOf('registerTool(')));
  if (endpoint) tools.push({ name, endpoint, readOnlyHint: readOnly });
}

// --- the admin-only set --------------------------------------------------
// The set literal may carry comments between entries, so strip comments first.
const setBody = /const ADMIN_ONLY = new Set\(\[([\s\S]*?)\]\)/.exec(serverSource)?.[1] ?? '';
const adminOnly = new Set([...setBody.replace(/\/\/[^\n]*/g, ' ').matchAll(/'(\/v1\/[^']+)'/g)].map(match => match[1]));

// --- the check -----------------------------------------------------------
// An MCP client authenticates as an adapter, so an admin-only endpoint is unreachable
// from the tool surface. That is a mismatch in one direction: visible but impossible.
const mismatches = tools.filter(tool => adminOnly.has(tool.endpoint));
const clean = tools.filter(tool => !adminOnly.has(tool.endpoint));

// The two already-found cases are recorded, not hidden: their descriptions now state
// admin-only and tell the agent to ask the user instead of retrying. They are listed
// here so this script can tell "the pair we know about" from "a new one appeared" —
// a check that is permanently red is a check nobody reads, and the point is to catch
// the next occurrence, not to keep reporting this one.
const KNOWN_AND_HANDLED = new Set(['amb_supersede_experience', 'amb_structure_skill']);
const unexpected = mismatches.filter(tool => !KNOWN_AND_HANDLED.has(tool.name));

if (asJson) {
  console.log(JSON.stringify({
    tools: tools.length,
    adminOnly: adminOnly.size,
    knownMismatches: mismatches.map(t => t.name),
    unexpected: unexpected.map(t => t.name),
    clean: clean.map(t => t.name),
  }, null, 2));
} else {
  console.log('MCP 工具面 × 服务端 admin 白名单 对账\n');
  console.log(`工具 ${tools.length} 个；admin-only 端点 ${adminOnly.size} 个。\n`);
  if (mismatches.length) {
    console.log('由适配器凭据调用、但端点属于 admin-only（调用必然 403）的工具：');
    for (const tool of mismatches) {
      const tag = KNOWN_AND_HANDLED.has(tool.name) ? '已知并已处置（描述已写明）' : '**新增，需要处理**';
      console.log(`  ${tool.name.padEnd(28)} → ${tool.endpoint}   ${tag}`);
    }
  } else {
    console.log('没有"可见但不可达"的工具。');
  }
  console.log(`\n其余 ${clean.length} 个工具调用的端点在适配器权限内。`);
  console.log('注意：本检查只看"能不能调到"，不看"该不该调到"。反方向的问题（适配器能调但语义上不该由它调）需要逐个工具读语义，脚本给不出结论。');
  if (unexpected.length) console.log(`\n新增不匹配 ${unexpected.length} 项 —— 必须处置，或按已知项的方式说明。`);
}
process.exit(unexpected.length ? 1 : 0);
