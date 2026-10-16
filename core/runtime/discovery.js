import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
// The same body limit the schema enforces, so a scanned document is never
// rejected later at import with a message that names neither the file nor the rule.
import { MAX_BODY_CHARS } from './schema.js';
const MAX_FILE_BYTES = 1_000_000;
/**
 * Filenames whose content drives host or plugin behaviour. Reading them is
 * harmless, but their contents must never be promoted into the knowledge base.
 */
const EXCLUDED_BASENAMES = new Set([
    'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'plugin.json',
    'cordis.patch.yml', 'dsh-plugin.naming.json', '.mcp.json', 'marketplace.json',
    'hooks.json', '.gitignore', '.npmrc', '.editorconfig',
]);
/** Extension-based exclusion: executable logic, host config, and binary payloads. */
const EXCLUDED_EXTENSIONS = new Set([
    '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx',
    '.py', '.rb', '.go', '.rs', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
    '.toml', '.yaml', '.yml', '.ini', '.conf',
    '.exe', '.dll', '.so', '.dylib', '.node', '.wasm',
    '.zip', '.tgz', '.tar', '.gz', '.7z',
    '.sqlite', '.sqlite3', '.db', '.jsonl',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
    '.woff', '.woff2', '.ttf', '.otf', '.pdf',
]);
/**
 * Path segments that mark a secret or runtime-state store. Matched per segment
 * so an ordinary parent directory named e.g. "work" never trips it.
 */
const EXCLUDED_SEGMENTS = new Set([
    'node_modules', '.git', '.hg', '.svn',
    'credentials', 'secrets', '.secrets',
    'sessions', 'history', 'logs', '.logs', 'tmp', '.tmp',
    '.ssh', '.aws', '.azure', '.gnupg', '.kube',
    'attachment', 'attachments', 'telemetry',
]);
/**
 * Baseline scan locations; only those that exist are returned.
 *
 * `pluginRoots` collects skill directories shipped inside installed host plugins,
 * so a plugin that arrives later is picked up by the next periodic sync instead
 * of needing a new configuration. The walk is depth-limited and stays read-only;
 * the exclusion rules still apply below each root.
 */
export function defaultScanRoots(home = homedir(), cwd = process.cwd()) {
    // Memories and journals live beside the skills. They are included because a
    // user's accumulated background is as much a part of "what this agent already
    // knows" as its rules, and leaving them out meant the sync step reported an
    // empty library while the material sat one directory away.
    const memories = ['.dsh', '.codex', '.agents'].map(dir => join(home, dir, 'memories'));
    const roots = [
        join(home, '.dsh', 'AGENTS.md'),
        join(home, '.codex', 'AGENTS.md'),
        join(home, '.agents', 'skills'),
        join(home, '.dsh', 'skills'),
        join(home, '.codex', 'skills'),
        ...memories,
        join(cwd, 'AGENTS.md'),
        join(cwd, '.agents', 'skills'),
    ];
    // Plugin-provided skills: `<host>/plugins/**/skills`. Depth-limited because
    // plugin trees are version-nested (…/<vendor>/<plugin>/<version>/skills).
    for (const hostDir of ['.codex', '.dsh', '.agents']) {
        const plugins = join(home, hostDir, 'plugins');
        if (!existsSync(plugins))
            continue;
        for (const found of findSkillDirectories(plugins, 5))
            roots.push(found);
    }
    return roots.filter(root => existsSync(root));
}
/**
 * Locate `skills` directories inside a plugin tree, bounded in depth.
 *
 * Returning the directory itself (not its parent) keeps the scan root meaningful:
 * exclusion rules are evaluated relative to the root, so a deep plugin path
 * containing segments like `cache` no longer hides everything beneath it.
 */
function findSkillDirectories(root, maxDepth) {
    const found = [];
    const walk = (dir, depth) => {
        if (depth > maxDepth)
            return;
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of names) {
            const full = join(dir, name);
            let info;
            try {
                info = lstatSync(full);
            }
            catch {
                continue;
            }
            // Never follow a link out of the tree.
            if (info.isSymbolicLink() || !info.isDirectory())
                continue;
            if (name.toLowerCase() === 'skills') {
                found.push(full);
                continue;
            }
            walk(full, depth + 1);
        }
    };
    walk(root, 0);
    return found;
}
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
/**
 * Filename stems that denote a credential store.
 *
 * Matched exactly, not as a substring: `secret-management.md` may be a legitimate
 * procedure, while `credentials.md` is a place secrets get written down. Adopted
 * text is injected into agent context, so a credential file must not travel in
 * even though it is Markdown.
 */
const CREDENTIAL_STEMS = new Set([
    'credentials', 'credential', 'secrets', 'secret',
    'passwords', 'password', 'passwd', 'tokens', 'token',
    'apikeys', 'api-keys', 'api_keys', 'private-keys', 'privatekeys',
]);
/**
 * Return the exclusion reason, or undefined when the file is a knowledge candidate.
 *
 * `path` must be the path *relative to the scan root*, not an absolute path.
 * Segment rules such as `cache` exist to skip runtime state inside a scan tree;
 * applied to an absolute path they would also reject a root that legitimately
 * lives under a directory of that name — which is exactly where hosts keep
 * installed plugins, so plugin-provided skills would silently vanish.
 */
export function exclusionReason(path, name) {
    const lower = name.toLowerCase();
    if (EXCLUDED_BASENAMES.has(lower)) {
        return `host or plugin manifest (${name}); changing it would alter agent behaviour`;
    }
    if (lower.startsWith('.env'))
        return 'environment file may hold credentials';
    const dot = lower.lastIndexOf('.');
    const extension = dot > 0 ? lower.slice(dot) : '';
    if (EXCLUDED_EXTENSIONS.has(extension)) {
        return `host configuration, executable logic, or binary payload (${extension}); not knowledge`;
    }
    // A credential document stays out even when it is Markdown.
    const stem = dot > 0 ? lower.slice(0, dot) : lower;
    if (CREDENTIAL_STEMS.has(stem)) {
        return `credential document (${name}); secrets must not enter the knowledge base`;
    }
    // Only segments below the scan root matter; the caller passes the relative path.
    for (const segment of path.toLowerCase().split(/[\\/]/)) {
        if (EXCLUDED_SEGMENTS.has(segment))
            return `runtime or secret store path segment (${segment})`;
    }
    return undefined;
}
/** Instruction files the host loads natively, so they must not be re-injected. */
const HOST_LOADED_INSTRUCTIONS = new Set(['agents.md', 'claude.md', 'agent.md']);
/**
 * A daily journal entry, named for its date.
 *
 * Both hosts write these (`daily/2026-09-25.md`), and without a rule they fell
 * through to "markdown outside a skill entry" and were dropped — so the journal
 * the user asked to sync was the one thing that never arrived.
 *
 * Matched on the stem rather than the directory: the date is the reliable part of
 * the convention, and a `daily/` folder is not something every host uses. A file
 * whose name is not a date is left to the other rules, so this cannot quietly
 * start treating arbitrary Markdown as knowledge.
 */
const JOURNAL_STEM = /^\d{4}-\d{2}-\d{2}$/;
/** Files that hold stated working preferences rather than rules. */
const PREFERENCE_FILES = new Set(['preferences.md', 'preference.md', 'user-preferences.md']);
/**
 * Classify a document by its filename; the path plays no part in the decision.
 *
 * A filename can only tell the types apart when the convention is explicit. The
 * design treats rules, preferences, facts, experience and diaries as separate
 * types, but a single `AGENTS.md` mixes rules with habits in prose, and splitting
 * it needs semantic judgement — which is the model classifier's job, not the
 * scanner's. The scanner therefore claims only what a name can prove: an
 * instruction file is a norm (the reading that cannot be ignored), a preferences
 * file is a preference, and everything else keeps its own rule or stays out.
 */
function classifyKnowledgeDoc(name) {
    const lower = name.toLowerCase();
    const dot = lower.lastIndexOf('.');
    const stem = dot > 0 ? lower.slice(0, dot) : lower;
    if (PREFERENCE_FILES.has(lower)) {
        return { kind: 'preference', rationale: 'working-preferences file: how the user prefers to work, not a rule to enforce' };
    }
    if (lower === 'agents.md' || lower === 'claude.md' || lower === 'agent.md') {
        return { kind: 'norm', rationale: 'agent instruction file: current working requirements and preferences' };
    }
    if (lower === 'memory.md' || lower === '.memory.md') {
        return { kind: 'memory', rationale: 'agent memory file: durable facts to remember across sessions' };
    }
    if (JOURNAL_STEM.test(stem)) {
        return { kind: 'journal', rationale: 'dated journal entry: a record of what was worked on and learned that day' };
    }
    if (lower === 'skill.md') {
        return { kind: 'skill', rationale: 'skill entry document: a reusable procedure with triggers and prerequisites' };
    }
    return undefined;
}
const isSkillEntry = (name) => name.toLowerCase() === 'skill.md';
/**
 * Scan the given roots without writing anything.
 *
 * Every visited file is either reported as a candidate (or as a leaf of one)
 * or listed under `excluded` with a reason, so both sides are auditable.
 *
 * Markdown files that are neither an entry document nor a host manifest are
 * treated as *leaves* of the nearest enclosing skill, because a skill is one
 * complete workflow: its reference documents must travel with the entry rather
 * than be promoted as standalone fragments.
 */
export function discover(roots = defaultScanRoots(), maxFiles = 5_000) {
    const candidates = [];
    const excluded = [];
    const seenId = new Set();
    const seenLeaf = new Set();
    let inspected = 0;
    /**
     * Readable markdown that is not a manifest and not itself an entry document.
     *
     * `relative` is the path below the scan root and is what exclusion rules are
     * evaluated against, so a root that happens to sit under a directory named
     * `cache` (the usual plugin install location) is not skipped wholesale.
     *
     * A document longer than the schema's body limit is rejected here rather than
     * at import: the scan is where the reason can still be reported against a path,
     * and letting it through made the whole adoption batch fail on one file.
     */
    const readableMarkdown = (path, relative, name, size) => {
        if (!name.toLowerCase().endsWith('.md'))
            return undefined;
        if (exclusionReason(relative, name))
            return undefined;
        if (size > MAX_FILE_BYTES)
            return undefined;
        let text;
        try {
            text = readFileSync(path, 'utf8');
        }
        catch {
            return undefined;
        }
        if (text.includes('\uFFFD'))
            return undefined;
        if (text.length > MAX_BODY_CHARS)
            return undefined;
        return text;
    };
    /**
     * Real paths already scanned as a root.
     *
     * Two scan roots can name the same directory — one by its path, another through
     * a junction — and walking it twice would report every document as a duplicate
     * of itself. Recorded on the resolved path, which is what the second visit sees.
     */
    const resolvedRoots = new Set();
    const visit = (path, relative) => {
        if (inspected > maxFiles)
            return;
        let info;
        // lstat, not stat: a link must stay visible as a link so it is never followed.
        try {
            info = lstatSync(path);
        }
        catch {
            return;
        }
        if (info.isSymbolicLink()) {
            // A configured or default root is the user's own pointer, so it is resolved.
            //
            // On this machine `~/.dsh/skills` and `~/.dsh/memories` are junctions into a
            // shared data directory. Refusing to resolve them meant the default scan
            // reported an almost empty library while the user's skills sat one link
            // away: 62 candidates instead of 87, with nothing in the output saying the
            // main skills directory had been skipped.
            //
            // Only the root is resolved. A link *inside* a tree is still refused, which
            // is what stops a stray junction from walking out of the scanned area.
            if (relative === '') {
                let real;
                try {
                    real = realpathSync(path);
                }
                catch {
                    excluded.push({ path, reason: 'symbolic link; not followed (cannot be resolved)' });
                    return;
                }
                // Two roots can point at one directory; scanning it twice would report
                // every document as a duplicate of itself.
                if (resolvedRoots.has(real))
                    return;
                resolvedRoots.add(real);
                visit(real, '');
                return;
            }
            excluded.push({ path, reason: 'symbolic link; not followed' });
            return;
        }
        if (info.isDirectory()) {
            const segment = basename(path).toLowerCase();
            // The root itself is never excluded by name; only directories below it.
            if (relative && EXCLUDED_SEGMENTS.has(segment)) {
                excluded.push({ path, reason: `runtime or secret store path segment (${segment})` });
                return;
            }
            let names;
            try {
                names = readdirSync(path).sort();
            }
            catch {
                excluded.push({ path, reason: 'unreadable directory' });
                return;
            }
            for (const name of names)
                visit(join(path, name), relative ? join(relative, name) : name);
            return;
        }
        if (!info.isFile())
            return;
        inspected += 1;
        const name = basename(path);
        const exclusion = exclusionReason(relative, name);
        if (exclusion) {
            excluded.push({ path, reason: exclusion });
            return;
        }
        const classification = classifyKnowledgeDoc(name);
        if (!classification) {
            // Leaves are collected under their skill entry during the skill-tree walk
            // below; a markdown file reached outside any skill entry is reported as
            // excluded rather than promoted as an isolated fragment.
            const text = readableMarkdown(path, relative, name, info.size);
            if (text === undefined) {
                excluded.push({ path, reason: name.toLowerCase().endsWith('.md') ? 'unreadable or oversized markdown' : 'not a recognised knowledge document' });
                return;
            }
            const hash = sha256(text);
            if (seenLeaf.has(hash)) {
                excluded.push({ path, reason: 'same content already reported from another path' });
                return;
            }
            seenLeaf.add(hash);
            excluded.push({ path, reason: 'markdown outside a skill entry; not adopted as a standalone fragment' });
            return;
        }
        if (info.size > MAX_FILE_BYTES) {
            excluded.push({ path, reason: `larger than ${MAX_FILE_BYTES} bytes; not adopted` });
            return;
        }
        let text;
        try {
            text = readFileSync(path, 'utf8');
        }
        catch {
            excluded.push({ path, reason: 'unreadable file' });
            return;
        }
        if (text.includes('\uFFFD')) {
            excluded.push({ path, reason: 'not valid UTF-8; skipped rather than rewriting content' });
            return;
        }
        // Report the overlong document here, by path and size, so the user learns
        // which file and how far over it is. Previously such a document passed the
        // scan and then failed the whole import with one message that named neither
        // the file nor the limit.
        if (text.length > MAX_BODY_CHARS) {
            excluded.push({
                path,
                reason: `body is ${text.length} characters, over the ${MAX_BODY_CHARS}-character limit for one entry; split it or adopt it manually`,
            });
            return;
        }
        const hash = sha256(text);
        const id = `${classification.kind}:${hash.slice(0, 16)}`;
        if (seenId.has(id)) {
            excluded.push({ path, reason: 'same content already reported from another path' });
            return;
        }
        seenId.add(id);
        const heading = text.split('\n').map(line => line.trim()).find(line => line.startsWith('#'));
        const candidate = {
            id, kind: classification.kind, title: heading ? heading.replace(/^#+\s*/, '') : name,
            source: { path, hash, bytes: info.size }, rationale: classification.rationale, body: text,
            hostProvided: classification.kind === 'norm' && HOST_LOADED_INSTRUCTIONS.has(name.toLowerCase()),
        };
        // For a skill entry, gather the reference/leaf documents in the same skill
        // directory so the complete procedure is visible as one item.
        if (isSkillEntry(name)) {
            const skillDir = resolve(path, '..');
            const leaves = [];
            const collect = (dir) => {
                let names;
                try {
                    names = readdirSync(dir).sort();
                }
                catch {
                    return;
                }
                for (const child of names) {
                    const full = join(dir, child);
                    if (full === path)
                        continue;
                    let childInfo;
                    try {
                        childInfo = lstatSync(full);
                    }
                    catch {
                        continue;
                    }
                    if (childInfo.isSymbolicLink())
                        continue;
                    if (childInfo.isDirectory()) {
                        // The same exclusion the top-level walk applies, repeated here because
                        // this subtree is walked separately: the walk screens a directory
                        // before descending, but its screening never reaches these children.
                        // Without it a skill's own `history/` archive, `tmp/`, or a stray
                        // `node_modules/` was adopted as reference leaves — so a skill that
                        // had been tidied up was pulled back in with its discarded drafts.
                        if (EXCLUDED_SEGMENTS.has(child.toLowerCase()))
                            continue;
                        collect(full);
                        continue;
                    }
                    if (!childInfo.isFile())
                        continue;
                    // A leaf's own name is what the name-based rules care about; the
                    // directories above it were screened by the branch above.
                    const leafText = readableMarkdown(full, child, child, childInfo.size);
                    if (leafText === undefined)
                        continue;
                    const leafHash = sha256(leafText);
                    if (seenLeaf.has(leafHash))
                        continue;
                    seenLeaf.add(leafHash);
                    leaves.push({ path: full, hash: leafHash, bytes: childInfo.size, body: leafText });
                }
            };
            collect(skillDir);
            if (leaves.length)
                candidate.leaves = leaves;
        }
        candidates.push(candidate);
    };
    const scannedRoots = roots.map(root => resolve(root));
    // Each root is visited with itself as the relative base, so a root living under
    // a directory named e.g. `cache` is not excluded by its own absolute path.
    for (const root of scannedRoots)
        visit(root, '');
    return { scannedRoots, candidates, excluded, inspected, wrote: false };
}
/**
 * Compare a discovery report against knowledge the core already holds.
 *
 * A conflict is reported, never auto-resolved: two texts can both be current
 * while disagreeing, and choosing a winner is the user's decision.
 */
export function diff(candidates, known) {
    const knownIds = new Set(known.map(item => item.id));
    const knownTitles = new Set(known.map(item => item.title));
    return candidates.map(candidate => {
        if (knownIds.has(candidate.id))
            return { ...candidate, change: 'duplicate' };
        if (knownTitles.has(candidate.title))
            return { ...candidate, change: 'conflict' };
        return { ...candidate, change: 'new' };
    });
}
/**
 * Compare a fresh scan against the adoption ledger, keyed by source path.
 *
 * Path is the identity here because a file keeps its meaning as its content
 * changes; content hash then distinguishes `unchanged` from `changed`. Entries
 * that disappeared are reported rather than removed: a file may be temporarily
 * absent (unmounted drive, renamed folder), and silently retiring the user's
 * knowledge because a path moved would be destructive.
 */
export function rescanDiff(report, ledger) {
    const active = ledger.filter(record => record.revokedAt === null);
    const byPath = new Map(active.map(record => [record.sourcePath, record]));
    const seenPaths = new Set();
    const entries = report.candidates.map(candidate => {
        const previous = byPath.get(candidate.source.path);
        seenPaths.add(candidate.source.path);
        if (!previous)
            return { ...candidate, status: 'new' };
        if (previous.contentHash === candidate.source.hash) {
            return { ...candidate, status: 'unchanged', knowledgeId: previous.knowledgeId };
        }
        return { ...candidate, status: 'changed', knowledgeId: previous.knowledgeId };
    });
    const vanished = active
        .filter(record => !seenPaths.has(record.sourcePath))
        .map(record => ({ sourcePath: record.sourcePath, knowledgeId: record.knowledgeId, title: record.title }));
    const counts = { new: 0, unchanged: 0, changed: 0, vanished: vanished.length };
    for (const entry of entries)
        counts[entry.status] += 1;
    return { entries, vanished, counts };
}
/** One-line rescan summary for logs and CLI output. */
export function summarizeRescan(report) {
    const { counts } = report;
    return `new=${counts.new} changed=${counts.changed} unchanged=${counts.unchanged} vanished=${counts.vanished}`;
}
/** Human-readable summary for the install report; never includes file contents. */
export function summarize(report) {
    const byKind = new Map();
    for (const candidate of report.candidates)
        byKind.set(candidate.kind, (byKind.get(candidate.kind) ?? 0) + 1);
    const counts = [...byKind.entries()].map(([kind, n]) => `${kind}=${n}`).join(' ');
    const leaves = report.candidates.reduce((total, candidate) => total + (candidate.leaves?.length ?? 0), 0);
    return [
        `roots=${report.scannedRoots.length} inspected=${report.inspected}`,
        `adoptable=${report.candidates.length}${counts ? ` (${counts})` : ''}`,
        `leaves=${leaves}`,
        `excluded=${report.excluded.length}`,
        'wrote=false',
    ].join(' ');
}
