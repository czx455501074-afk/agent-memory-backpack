import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Adapter-side run log.
 *
 * The adapter runs inside the host process, so it cannot borrow the core's
 * logger: when the core is unreachable, that is exactly when the adapter's own
 * record matters most. This file is therefore self-contained.
 *
 * An identical copy lives in each adapter package. `test/adapter-log.test.ts`
 * asserts the copies behave the same and are byte-identical, so the guarantee
 * cannot drift between them.
 *
 * Two properties are enforced here rather than left to call sites:
 *   - a credential never reaches the file (any secret-looking field is replaced);
 *   - logging never breaks the feature it observes (every write is guarded).
 */

const SECRET_FIELD = /token|authorization|secret|password|credential|apikey|api_key/i;
/**
 * Patterns that mark a secret inside an ordinary string value.
 *
 * Redacting by field name alone was not enough: a credential pasted into a free
 * -text field such as `message` was written verbatim, and a log is exactly where
 * a leaked token survives longest. The value is scanned as well as the key.
 */
const SECRET_VALUE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}|((?:sk|ghp|gho|xox[baprs])-[A-Za-z0-9-]{8,})/gi;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 500_000;
const KEEP = 2;

function redact(value, depth = 0) {
  if (depth > 4) return '[depth]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE, (_all, bearer) => bearer ? `${bearer}[redacted]` : '[redacted]');
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 30).map(item => redact(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_FIELD.test(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return out;
}

/** Where the adapter writes its log: beside its config, or the default data dir. */
export function defaultLogPath(env = process.env) {
  const explicit = env.AMB_LOG_DIR?.trim();
  if (explicit) return resolve(explicit);
  const configPath = env.AMB_DSH_CONFIG?.trim() || env.AMB_CONFIG?.trim();
  if (configPath) return resolve(configPath, '..');
  return join(homedir(), '.agent-memory-backpack');
}

export function createAdapterLogger(options = {}) {
  const dir = options.dir ?? defaultLogPath();
  const level = options.level ?? process.env.AMB_LOG_LEVEL ?? 'info';
  const now = options.now ?? Date.now;
  const file = join(dir, 'amb-plugin.log.jsonl');
  let degraded = false;

  try { mkdirSync(dir, { recursive: true }); } catch { degraded = true; }

  function rotate() {
    if (!existsSync(file) || statSync(file).size < MAX_BYTES) return;
    for (let index = KEEP - 1; index >= 1; index -= 1) {
      const from = `${file}.${index}`;
      if (existsSync(from)) { try { renameSync(from, `${file}.${index + 1}`); } catch { /* keep going */ } }
    }
    try { renameSync(file, `${file}.1`); } catch { /* keep going */ }
  }

  function write(recordLevel, event, fields) {
    if (degraded || LEVELS[recordLevel] < LEVELS[level]) return;
    const record = { ts: new Date(now()).toISOString(), level: recordLevel, event, ...redact(fields ?? {}) };
    try {
      rotate();
      appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // A failed write must never propagate: the caller is mid-operation.
      degraded = true;
    }
  }

  return Object.freeze({
    file,
    isDegraded: () => degraded,
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    /** Read records back, newest last. Used by diagnostics. */
    read({ limit = 50, includeRotated = false } = {}) {
      const files = includeRotated ? [file, `${file}.1`, `${file}.2`] : [file];
      const records = [];
      for (const candidate of files) {
        if (!existsSync(candidate)) continue;
        let text;
        try { text = readFileSync(candidate, 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try { records.push(JSON.parse(line)); } catch { /* skip a torn line */ }
        }
      }
      return limit ? records.slice(-limit) : records;
    },
  });
}
