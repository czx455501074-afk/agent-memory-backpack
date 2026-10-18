/**
 * Credential-shaped text: one definition, used by every path that reads or writes it.
 *
 * Two paths need this judgement and they must not disagree:
 *
 *   - the **export guard**, which refuses a backup that would carry a credential-shaped value
 *     (and can be asked to redact instead);
 *   - the **write path**, which sanitises text *before* it lands in the library.
 *
 * They used to be one function inside `backup.ts`, which meant the write path had no guard at
 * all: a library could store `api_key=sk-live-…` verbatim and only discover it when an export
 * was refused — by which point the value is in the database, in every backup, and in the
 * search index. The comparison that made this concrete: peer projects sanitise on ingest, this
 * one only refused on export.
 *
 * Judging by *shape* is deliberate and has a known cost: a document that teaches the format
 * ("write `api_key=<key>`") is indistinguishable from one that holds a key, so the placeholder
 * allowlist below exists to keep teaching text intact. When a value is genuinely ambiguous the
 * callers redact rather than guess, and say what they did.
 */

/**
 * Placeholder values that documentation uses to *teach* how to supply a credential.
 *
 * A library that explains an API necessarily contains strings like `API_KEY=...` or
 * `Bearer <token>`. Treating those as secrets would make every guard useless in practice,
 * because it blocks exactly the entries that help a later reader - and the bytes it blocks
 * are the instruction, not a secret. The rule is therefore kept, and the *placeholder form*
 * is allowlisted narrowly: a live key in the same body is still refused.
 */
const PLACEHOLDER_VALUE = /^(?:<[^>]*>?|\{\{[^}]*\}\}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\.{2,}|…+|[xX*]{2,}|(?:YOUR|MY|THE)[_-].*|REPLACE[_-]?.*|CHANGE[_-]?ME|TODO|FIXME|NONE|NULL|SECRET|PASSWORD|TOKEN|KEY|VALUE|EXAMPLE|SAMPLE|DUMMY|FAKE|TEST[A-Z_]*|[a-z_]+[_-]?key|your[_-]?[a-z]*|placeholder|redacted|omitted)?$/i;

/**
 * Whether a matched credential-shaped value is really just a placeholder.
 *
 * `strict` applies to values that follow a *token prefix* (`sk-`, `ghp_`, `Bearer`): those
 * prefixes only ever appear in front of a credential, so the value must carry an explicit
 * placeholder marker to pass. A long run of letters with no marker is a key as far as this
 * guard is concerned - even when it happens to contain no digits, which is the one signal
 * that otherwise reads as "prose".
 *
 * The default (`strict = false`) applies to values that follow a *setting name*
 * (`api_key=`, `password=`, `client_secret=`), where the value is usually an English word
 * lifted from documentation. There "contains no digit" is a sound signal for prose.
 */
export function isPlaceholderValue(value: string | undefined, strict = false): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim().replace(/^["']|["'`,;)\]]+$/g, '');
  // An empty result means the pattern matched a bare key with nothing after it, which carries
  // no secret to leak.
  if (trimmed === '') return true;
  if (PLACEHOLDER_VALUE.test(trimmed)) return true;
  // A value built out of variable or template syntax is a reference, not a secret:
  // `$RUNPOD_API_KEY`, `${{ secrets.TOKEN }}`, `${KEY}`.
  if (/[$%{}<>]/.test(trimmed)) return true;
  // Runs of one repeated character are the standard "type something here" filler.
  if (/(.)\1{2,}/.test(trimmed)) return true;
  // No digit means prose - but only where the surrounding syntax is a setting name.
  if (!/\d/.test(trimmed)) return !strict;
  return false;
}

/**
 * Every credential shape this project recognises, as one pattern.
 *
 * Each alternative captures the value that follows the key, so the decision is made about
 * that value rather than about the whole string. `token` on its own is deliberately absent:
 * the word appears in ordinary prose far more often than it introduces a credential, and a
 * pattern that matched it would redact sentences instead of secrets.
 */
export const CREDENTIAL_PATTERN = /\b(?:sk-([a-zA-Z0-9_-]{16,})|gh[pousr]_([a-zA-Z0-9]{20,})|Bearer\s+([a-zA-Z0-9._-]+))|-----BEGIN .*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*["']?\s*[:=]\s*["']?([^\s"',}]+)/i;

/** What was replaced, and where — never the value. */
export interface RedactionFinding { where: string; rule: string }

/** The replacement written in place of a credential-shaped value. */
export const REDACTED = '[REDACTED-CREDENTIAL]';

/** The rule that fired, named for a reader rather than for the pattern. */
function ruleName(m: { [index: number]: string | undefined }, privateKeyHeader: boolean): string {
  if (privateKeyHeader) return '私钥头';
  if (m[1] !== undefined) return 'sk- 前缀';
  if (m[2] !== undefined) return 'GitHub token 前缀';
  if (m[3] !== undefined) return 'Bearer 值';
  return '凭据字段赋值';
}

/**
 * The rule a match violates, or undefined when the match is a placeholder or a description.
 *
 * Decide by the *value's own shape*, not by which capture group fired: the alternation tries
 * `api_key=` before `sk-`, so for `api_key=sk-abcdef...` the value arrives in group 4 while
 * still carrying a token prefix. Looking only at the group made that case take the tolerant
 * path and let a key through.
 *
 * Length gates the strictness, because `Bearer` also introduces plain English in prose
 * ("Bearer error", "bearer token expired") and a short word like that must never be read as a
 * credential. A credential of any real format is long; nothing shorter than this threshold can
 * be one.
 */
export function credentialRule(m: { [index: number]: string | undefined }): string | undefined {
  const value = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
  const tokenPrefix = /^(?:sk-|gh[pousr]_)/i.test(value) || m[3] !== undefined;
  const followsTokenPrefix = tokenPrefix && value.length >= 24;
  // A real header reads `-----BEGIN RSA PRIVATE KEY-----`; prose that *describes* the pattern
  // writes it with regex metacharacters (`-----BEGIN .*PRIVATE KEY-----`), which no actual
  // header contains. The literal form is always refused.
  const raw = m[0] ?? '';
  const privateKeyHeader = raw.toUpperCase().includes('PRIVATE KEY');
  const describedNotMaterial = /[*?(){}[\]]/.test(raw);
  if (privateKeyHeader ? describedNotMaterial : isPlaceholderValue(value, followsTokenPrefix)) return undefined;
  return ruleName(m, privateKeyHeader);
}

/**
 * Rewrite every credential-shaped value in one string, keeping the key that introduced it.
 *
 * Only the value is replaced; the key stays, so a reader can still see that something of this
 * kind was there and where it was.
 */
export function redactInString(text: string, where: string, findings: RedactionFinding[]): string {
  const pattern = new RegExp(CREDENTIAL_PATTERN.source, 'gi');
  return text.replace(pattern, (...args: unknown[]) => {
    const match = String(args[0]);
    const groups = args.slice(1, 5) as Array<string | undefined>;
    const m = { 0: match, 1: groups[0], 2: groups[1], 3: groups[2], 4: groups[3] };
    const rule = credentialRule(m);
    if (!rule) return match;
    const value = groups[0] ?? groups[1] ?? groups[2] ?? groups[3] ?? '';
    findings.push({ where, rule });
    return match.slice(0, match.length - value.length) + REDACTED;
  });
}

/**
 * Rewrite one value tree, leaving untouched bytes untouched.
 *
 * A hit-free value is returned by reference, so a library that needs no redaction is stored
 * byte-for-byte as written — the only strings that change are the ones that carried a
 * credential-shaped value.
 */
export function redactValue(value: unknown, where: string, findings: RedactionFinding[]): unknown {
  if (typeof value === 'string') {
    // An embedded JSON document is the usual shape here: a knowledge body arrives as a JSON
    // *string*. Recursing into it keeps one rule set, so the field-name rule sees the same
    // keys the strict scan would have seen.
    if (/^\s*[\[{]/.test(value)) {
      try {
        const before = findings.length;
        const rewritten = redactValue(JSON.parse(value), where, findings);
        return findings.length === before ? value : JSON.stringify(rewritten);
      } catch { /* not JSON: treat the string as text */ }
    }
    return redactInString(value, where, findings);
  }
  if (Array.isArray(value)) return value.map((item, index) => redactValue(item, `${where}[${index}]`, findings));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // A field *named* like a credential is treated as one even when its value looks like
      // prose: the name is the claim, and the cost of being wrong is a redacted sentence
      // rather than a leaked key.
      if (/^(?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|credentials?)$/i.test(key)) {
        findings.push({ where: `${where}.${key}`, rule: '凭据字段名' });
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactValue(item, `${where}.${key}`, findings);
    }
    return out;
  }
  return value;
}

/** Redact a whole value tree, reporting what was replaced and where. */
export function redactDeep<T>(value: T, where: string): { value: T; findings: RedactionFinding[] } {
  const findings: RedactionFinding[] = [];
  return { value: redactValue(value, where, findings) as T, findings };
}

/** One line for a receipt or a log: how many, and where — never what. */
export function describeRedactions(findings: RedactionFinding[], limit = 4): string {
  const shown = findings.slice(0, limit).map(item => `${item.where}〔${item.rule}〕`).join('；');
  const rest = findings.length > limit ? `；另有 ${findings.length - limit} 处` : '';
  return `${findings.length} 处凭据形状的内容已替换为 ${REDACTED}（${shown}${rest}）。原值一律不回显。`;
}
