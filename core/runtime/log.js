import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
/** Severity order, exported so readers can filter by level with the same rule. */
export const LOG_LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
/** Field names that must never be written, matched case-insensitively. */
const SECRET_FIELD = /token|authorization|secret|password|credential|apikey|api_key/i;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_KEEP = 3;
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
function redactString(value) {
    return value
        // The query parameter rule runs first: it needs the parameter name, which the
        // generic rule would otherwise not consume but could mask by rewriting the
        // value's prefix in a longer token.
        .replace(SECRET_QUERY_PARAM, '$1[redacted]')
        .replace(SECRET_VALUE, (_all, bearer) => bearer ? `${bearer}[redacted]` : '[redacted]');
}
function redact(value, depth = 0) {
    if (depth > 4)
        return '[depth]';
    if (typeof value === 'string')
        return redactString(value);
    if (value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.slice(0, 50).map(item => redact(item, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        out[key] = SECRET_FIELD.test(key) ? '[redacted]' : redact(item, depth + 1);
    }
    return out;
}
export class Logger {
    dir;
    file;
    level;
    maxBytes;
    keep;
    now;
    degraded = false;
    constructor(dir, options = {}) {
        this.dir = dir;
        this.level = options.level ?? process.env.AMB_LOG_LEVEL ?? 'info';
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
        this.keep = options.keep ?? DEFAULT_KEEP;
        this.now = options.now ?? Date.now;
        this.file = join(dir, options.fileName ?? 'amb.log.jsonl');
        try {
            mkdirSync(dir, { recursive: true });
        }
        catch {
            this.degraded = true;
        }
    }
    /** True when the log could not be written; surfaced by `doctor`. */
    get isDegraded() { return this.degraded; }
    write(level, event, fields = {}) {
        if (this.degraded || LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.level])
            return;
        const record = {
            ts: new Date(this.now()).toISOString(), level, event,
            ...redact(fields),
        };
        try {
            this.rotate();
            appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
        }
        catch {
            // A failed write must never propagate: the caller is mid-operation.
            this.degraded = true;
        }
    }
    rotate() {
        if (!existsSync(this.file))
            return;
        if (statSync(this.file).size < this.maxBytes)
            return;
        for (let index = this.keep - 1; index >= 1; index -= 1) {
            const from = `${this.file}.${index}`;
            if (existsSync(from)) {
                try {
                    renameSync(from, `${this.file}.${index + 1}`);
                }
                catch { /* keep going */ }
            }
        }
        try {
            renameSync(this.file, `${this.file}.1`);
        }
        catch { /* keep going */ }
        const oldest = `${this.file}.${this.keep + 1}`;
        if (existsSync(oldest)) {
            try {
                unlinkSync(oldest);
            }
            catch { /* keep going */ }
        }
    }
    debug(event, fields) { this.write('debug', event, fields); }
    info(event, fields) { this.write('info', event, fields); }
    warn(event, fields) { this.write('warn', event, fields); }
    error(event, fields) { this.write('error', event, fields); }
    /**
     * Record the environment once per process start.
     *
     * Version stamps are what make an old log interpretable after the host or this
     * plugin has been updated, so they are written even when nothing else is.
     */
    stamp(meta) {
        this.write('info', 'run.start', meta);
    }
    /** Read recent records, newest last. Used by the `logs` command. */
    read(options = {}) {
        const files = [this.file];
        if (options.includeRotated) {
            for (let index = 1; index <= this.keep; index += 1)
                files.push(`${this.file}.${index}`);
        }
        const records = [];
        for (const file of files) {
            if (!existsSync(file))
                continue;
            let text;
            try {
                text = readFileSync(file, 'utf8');
            }
            catch {
                continue;
            }
            for (const line of text.split('\n')) {
                if (!line.trim())
                    continue;
                try {
                    records.push(JSON.parse(line));
                }
                catch { /* skip a torn line */ }
            }
        }
        let filtered = records;
        if (options.level) {
            const floor = LOG_LEVEL_ORDER[options.level];
            filtered = filtered.filter(record => LOG_LEVEL_ORDER[record.level] >= floor);
        }
        if (options.event)
            filtered = filtered.filter(record => record.event.includes(options.event));
        return options.limit ? filtered.slice(-options.limit) : filtered;
    }
}
