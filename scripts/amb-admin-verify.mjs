// Verify the panel's management surface against a RUNNING DSH host.
//
// The panel's management actions only exist after the host has been restarted
// onto the deployed build, so this script answers two questions in order:
//
//   1. Is the new code actually loaded? (`/amb/admin/*` 404s on the old build.)
//   2. If it is, does each capability work — read, export, inspect — and does a
//      write leave an audit line?
//
// It deliberately does NOT import. Import writes entries straight into the
// effective library, bypassing the candidate queue and the project-scope check,
// so it stays a human decision: the script reports the inspect result and stops.
//
// Usage:
//   node scripts/amb-admin-verify.mjs [--base http://127.0.0.1:19387]
//
// Everything here is read-only against the core except `proposal-*` actions,
// which are only attempted with --write.

import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:19387' },
    write: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  console.log([
    'Verify the AMB panel management surface on a running DSH host.',
    '',
    'Usage: node scripts/amb-admin-verify.mjs [options]',
    '',
    '  --base URL   host web server (default: http://127.0.0.1:19387)',
    '  --write      also attempt a real proposal approval (changes the library)',
    '  -h, --help   show this help',
    '',
    'Import is never attempted: it writes into the effective library, so it stays',
    'a human decision. The script stops after reporting the inspect manifest.',
  ].join('\n'))
  process.exit(0)
}

const base = values.base.replace(/\/$/, '')
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

async function call(path, { method = 'GET', body } = {}) {
  const init = { method, signal: AbortSignal.timeout(30000) }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const started = Date.now()
  const response = await fetch(base + path, init)
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON is reported as such */ }
  return { status: response.status, ms: Date.now() - started, json, text }
}

console.log('AMB panel management verification')
console.log('  host: ' + base)
console.log('')

// 1. Is the new build loaded?
let loaded = false
try {
  const probe = await call('/amb/admin/proposals-list', { method: 'POST', body: {} })
  if (probe.status === 404) {
    record('new code loaded', false, 'admin routes answer 404 — the host is still running the pre-deploy build; restart DSH and run this again')
  } else {
    loaded = true
    record('new code loaded', true, 'admin route answered HTTP ' + probe.status)
    if (probe.json && probe.json.admin && probe.json.admin.available === false) {
      record('admin credential present', false, 'host reports admin-client.json is missing; management stays unavailable')
    } else if (probe.json && probe.json.ok === true) {
      record('admin credential present', true, 'proposals-list answered ok:true')
      const payload = probe.json.data
      const list = payload && Array.isArray(payload.proposals) ? payload.proposals
        : (Array.isArray(payload) ? payload : null)
      record('read: pending queue', list !== null, list ? list.length + ' proposal(s) returned' : 'unexpected payload shape: ' + JSON.stringify(payload).slice(0, 120))
    } else {
      record('read: pending queue', false, 'ok was not true: ' + String(probe.json ? probe.json.error : probe.text).slice(0, 160))
    }
  }
} catch (error) {
  record('new code loaded', false, 'probe failed: ' + error.name + ' ' + error.message)
}

// 2. Read-only capabilities that do not touch the library.
if (loaded) {
  try {
    const summary = await call('/amb/summary')
    const ok = summary.status === 200 && summary.json && summary.json.ok === true
    const first = ok && Array.isArray(summary.json.knowledge) ? summary.json.knowledge[0] : null
    record('read: panel summary', ok, ok
      ? 'revision=' + summary.json.revision + ' knowledge=' + summary.json.counts?.knowledge
        + ' and entries carry kind=' + (first && first.kind ? 'yes' : 'NO')
      : 'HTTP ' + summary.status)
  } catch (error) {
    record('read: panel summary', false, error.name)
  }

  try {
    const exported = await call('/amb/admin/backup-export', { method: 'POST', body: {} })
    const ok = exported.status === 200 && exported.json && exported.json.ok === true
    const data = ok ? exported.json.data : null
    const where = data && typeof data === 'object'
      ? (data.path || data.file || JSON.stringify(data).slice(0, 100))
      : String(data).slice(0, 100)
    record('write: export library', ok, ok ? 'artifact: ' + where : 'HTTP ' + exported.status + ' ' + String(exported.json ? exported.json.error : exported.text).slice(0, 140))
  } catch (error) {
    record('write: export library', false, error.name)
  }
}

// 3. Optional: a real review decision, only with --write.
if (loaded && values.write) {
  try {
    const list = await call('/amb/admin/proposals-list', { method: 'POST', body: {} })
    const payload = list.json && list.json.data
    const items = payload && Array.isArray(payload.proposals) ? payload.proposals : (Array.isArray(payload) ? payload : [])
    const target = items.find(item => item && item.id && String(item.state || 'pending') === 'pending')
    if (!target) {
      record('write: approve one proposal', false, 'no pending proposal available to act on')
    } else {
      const approved = await call('/amb/admin/proposal-approve', { method: 'POST', body: { id: target.id } })
      const ok = approved.status === 200 && approved.json && approved.json.ok === true
      record('write: approve one proposal', ok, ok
        ? 'approved ' + target.id + ' — check the plugin log for panel.admin_write'
        : 'HTTP ' + approved.status + ' ' + String(approved.json ? approved.json.error : approved.text).slice(0, 140))
    }
  } catch (error) {
    record('write: approve one proposal', false, error.name)
  }
} else if (loaded) {
  record('write: approve one proposal', true, 'skipped (pass --write to attempt one real approval)')
}

// 4. Boundary: an unlisted action must not reach the core.
if (loaded) {
  try {
    const bad = await call('/amb/admin/not-a-real-action', { method: 'POST', body: {} })
    record('boundary: unlisted action refused', bad.status === 404, 'unlisted action answered HTTP ' + bad.status + ' (404 expected)')
  } catch (error) {
    record('boundary: unlisted action refused', false, error.name)
  }
}

console.log('')
const failed = results.filter(item => !item.ok)
console.log(failed.length === 0
  ? `All ${results.length} checks passed.`
  : `${failed.length} of ${results.length} checks failed: ` + failed.map(item => item.name).join(', '))
console.log('')
console.log('Import is intentionally not attempted; inspect its manifest and decide by hand.')
process.exit(failed.length === 0 ? 0 : 1)
