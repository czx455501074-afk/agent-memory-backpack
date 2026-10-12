import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Structured, rotating run log.
 *
 * Purpose: make a failure diagnosable after the fact without asking the user to
 * reproduce it. Records are one JSON object per line so they can be filtered
 * with ordinary tools, and every record carries an event name plus whatever
 * fields the call site considered relevant.
 *
 * Two rules the logger enforces rather than trusts:
 *
 *  - A credential never reaches the file. Any field whose name looks like a
 *    secret is replaced before writing, because the call sites cannot be relied
 *    on to remember.
 *  - Logging never breaks the feature it observes. Every write is guarded, so a
 *    read-only or full disk degrades to silence instead of a thrown error.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Severity order, exported so readers can filter by level with the same rule. */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names that must never be written, matched case-insensitively. */
const SECRET_FIELD = /token|authorization|secret|password|credential|apikey|api_key/i;

const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_KEEP = 3;

export interface LogRecord {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  level?: LogLevel;
  maxBytes?: number;
  keep?: number;
  now?: () => number;
}

/**
 * Patterns that mark a secret inside an ordinary string value.
 *
 * Redacting by field name alone was not enough: a credential pasted into a free
 * -text field such as `message` or `note` was written verbatim, and a log is
 * exactly where a leaked token survives longest. The value is scanned as well as
 * the key.
 *
 * A URL's query string is the same hazard in a shape the patterns above miss: a
 * key travels as `?api_key=...` or `&access_token=...`, where the secret is the
 * *value* of a parameter rather than something with a recognisable prefix. A
 * probe confirmed that such a URL was written verbatim. The parameter names that
 * carry credentials are therefore matched explicitly, and a bare `key` is
 * included because services that accept it usually mean exactly this.
 */
const SECRET_VALUE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}|((?:sk|ghp|gho|xox[baprs])-[A-Za-z0-9-]{8,})/gi;

/**
 * Query parameters whose value is a credential.
 *
 * Deliberately a name list rather than "redact every query value": dropping the
 * whole query would destroy the diagnostic value of the URL, and a log record
 * that cannot say which page was fetched is not worth writing. Only the values
 * that are secrets get removed.
 */
const SECRET_QUERY_PARAM = /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|key|secret|password|passwd|pwd|sig|signature|credential)=)[^&#\s"']+/gi;

function redactString(value: string): string {
  return value
    // The query parameter rule runs first: it needs the parameter name, which the
    // generic rule would otherwise not consume but could mask by rewriting the
    // value's prefix in a longer token.
    .replace(SECRET_QUERY_PARAM, '$1[redacted]')
    .replace(SECRET_VALUE, (_all, bearer?: string) => bearer ? `${bearer}[redacted]` : '[redacted]');
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_FIELD.test(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return out;
}

export class Logger {
  readonly file: string;
  private readonly level: LogLevel;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => number;
  private degraded = false;

  constructor(private readonly dir: string, options: LoggerOptions = {}) {
    this.level = options.level ?? (process.env.AMB_LOG_LEVEL as LogLevel | undefined) ?? 'info';
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.keep = options.keep ?? DEFAULT_KEEP;
    this.now = options.now ?? Date.now;
    this.file = join(dir, 'amb.log.jsonl');
    try { mkdirSync(dir, { recursive: true }); } catch { this.degraded = true; }
  }

  /** True when the log could not be written; surfaced by `doctor`. */
  get isDegraded() { return this.degraded; }

  private write(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (this.degraded || LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.level]) return;
    const record: LogRecord = {
      ts: new Date(this.now()).toISOString(), level, event,
      ...(redact(fields) as Record<string, unknown>),
    };
    try {
      this.rotate();
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // A failed write must never propagate: the caller is mid-operation.
      this.degraded = true;
    }
  }

  private rotate(): void {
    if (!existsSync(this.file)) return;
    if (statSync(this.file).size < this.maxBytes) return;
    for (let index = this.keep - 1; index >= 1; index -= 1) {
      const from = `${this.file}.${index}`;
      if (existsSync(from)) {
        try { renameSync(from, `${this.file}.${index + 1}`); } catch { /* keep going */ }
      }
    }
    try { renameSync(this.file, `${this.file}.1`); } catch { /* keep going */ }
    const oldest = `${this.file}.${this.keep + 1}`;
    if (existsSync(oldest)) { try { unlinkSync(oldest); } catch { /* keep going */ } }
  }

  debug(event: string, fields?: Record<string, unknown>) { this.write('debug', event, fields); }
  info(event: string, fields?: Record<string, unknown>) { this.write('info', event, fields); }
  warn(event: string, fields?: Record<string, unknown>) { this.write('warn', event, fields); }
  error(event: string, fields?: Record<string, unknown>) { this.write('error', event, fields); }

  /**
   * Record the environment once per process start.
   *
   * Version stamps are what make an old log interpretable after the host or this
   * plugin has been updated, so they are written even when nothing else is.
   */
  stamp(meta: Record<string, unknown>): void {
    this.write('info', 'run.start', meta);
  }

  /** Read recent records, newest last. Used by the `logs` command. */
  read(options: { limit?: number; level?: LogLevel; event?: string; includeRotated?: boolean } = {}): LogRecord[] {
    const files = [this.file];
    if (options.includeRotated) {
      for (let index = 1; index <= this.keep; index += 1) files.push(`${this.file}.${index}`);
    }
    const records: LogRecord[] = [];
    for (const file of files) {
      if (!existsSync(file)) continue;
      let text: string;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line) as LogRecord); } catch { /* skip a torn line */ }
      }
    }
    let filtered = records;
    if (options.level) {
      const floor = LOG_LEVEL_ORDER[options.level];
      filtered = filtered.filter(record => LOG_LEVEL_ORDER[record.level] >= floor);
    }
    if (options.event) filtered = filtered.filter(record => record.event.includes(options.event!));
    return options.limit ? filtered.slice(-options.limit) : filtered;
  }
}
