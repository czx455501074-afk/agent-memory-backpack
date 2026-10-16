import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute, posix, win32 } from 'node:path';
/**
 * Export knowledge back to the host as ordinary skill files.
 *
 * The requirement this exists for: a skill must stay usable after the plugin is
 * gone. So the export is not a plugin-specific cache — it is the same
 * `SKILL.md` + `references/` layout the host already reads natively, with no
 * front matter that only this plugin understands.
 *
 * Rules the exporter holds to:
 *
 *  - It only writes files it owns, inside a single named directory. It never
 *    edits or deletes a user's own skill.
 *  - It never clobbers a directory that lacks its own marker file, so pointing
 *    it at an existing hand-written skill folder cannot destroy it.
 *  - Writes are hash-compared first: unchanged content is left alone, which
 *    keeps the export idempotent and avoids touching timestamps needlessly.
 */
/** Marker written inside the export directory; also records the format version. */
export const EXPORT_MARKER = 'agent-memory-backpack-export.json';
export const EXPORT_FORMAT = 'agent-memory-backpack-export-v1';
const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
/**
 * Directory-safe name for one entry.
 *
 * Readable first, unique second: the entry title identifies the folder for a
 * human, and a short hash of the id guarantees two entries with the same title
 * cannot collide. An entry id is already unique, so ids alone would work, but
 * `skill-462df6c36a33307b` tells a user nothing when browsing the tree.
 */
function slug(id, title) {
    const readable = (title ?? '')
        .replace(/[^\p{L}\p{N}_.-]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/g, '');
    const suffix = digest(id).slice(0, 8);
    return readable ? `${readable}-${suffix}` : `entry-${suffix}`;
}
/**
 * Render one knowledge entry as a standalone skill document.
 *
 * A workflow becomes a readable procedure; a skill keeps its original text so
 * nothing is paraphrased and nothing is lost. In both cases the result is plain
 * Markdown that a host can use without this plugin.
 */
export function renderSkill(entry, sourcePath) {
    const lines = [`# ${entry.title}`, ''];
    if (entry.kind === 'workflow') {
        lines.push(entry.overview, '', '## 触发条件', '');
        for (const trigger of entry.triggers)
            lines.push(`- ${trigger}`);
        lines.push('', '## 前提', '');
        for (const item of entry.preconditions)
            lines.push(`- ${item}`);
        lines.push('', '## 步骤', '');
        entry.stages.forEach((stage, index) => {
            lines.push(`${index + 1}. **${stage.title}**（id: ${stage.id}）`, '');
            lines.push(`   ${stage.instructions}`, '');
            lines.push('   检查项：', '');
            for (const check of stage.checks)
                lines.push(`   - ${check}`);
            if (stage.dependencies.length) {
                lines.push('', '   依赖：');
                for (const dependency of stage.dependencies) {
                    lines.push(`   - ${dependency.relationship}: ${dependency.workflowId}@${dependency.revision}`);
                }
            }
            lines.push('');
        });
        lines.push('## 完成判据', '');
        for (const item of entry.completion)
            lines.push(`- ${item}`);
        lines.push('', '## 失败处理', '', entry.recovery, '');
        if (entry.derivedFrom) {
            lines.push('## 来源', '', `由已采纳技能 ${entry.derivedFrom.skillId}@${entry.derivedFrom.skillRevision} 结构化，整理者：${entry.derivedFrom.derivedBy}。`, '');
        }
    }
    else if (entry.kind === 'skill') {
        // Verbatim: the adopted text is the user's own wording.
        lines.splice(0, lines.length, entry.body, '');
        if (entry.leaves.length) {
            lines.push('## 参考文档', '');
            for (const leaf of entry.leaves) {
                const location = leafExportPath(leaf.path, sourcePath);
                lines.push(`- [${location}](<${location}>)`);
            }
            lines.push('');
        }
    }
    else if (entry.kind === 'norm') {
        lines.push(entry.body, '');
    }
    else if (entry.kind === 'memory') {
        lines.push(entry.body, '');
    }
    else {
        return undefined;
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}
/** Keep paths relative to the adopted SKILL.md, including nested references.
 * Never flatten basenames: distinct a/readme.md and b/readme.md must survive.
 * Absolute legacy leaves without a source cannot be safely relocated by guessing.
 */
function leafExportPath(path, sourcePath) {
    const normalized = path.replace(/\\/g, '/');
    let value = normalized;
    if (win32.isAbsolute(path) || posix.isAbsolute(normalized)) {
        if (!sourcePath)
            throw new Error(`Absolute reference has no source SKILL.md: ${path}`);
        const api = win32.isAbsolute(sourcePath) ? win32 : posix;
        value = api.relative(api.dirname(sourcePath), path).replace(/\\/g, '/');
    }
    const segments = value.split('/');
    if (!value || segments.some(part => !part || part === '.' || part === '..'
        || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
        || value.toLowerCase() === 'skill.md') {
        throw new Error(`Unsafe reference path: ${path}`);
    }
    return value;
}
function ownedPath(root, target) {
    const rel = relative(root, target);
    if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes('..'))
        throw new Error('Export path leaves its owned directory');
    let current = root;
    for (const part of rel.split(/[\\/]/)) {
        current = join(current, part);
        if (existsSync(current) && lstatSync(current).isSymbolicLink())
            throw new Error('Export refuses symbolic links in its output');
    }
}
function checkWorkflowReady(workflow, allMap, ancestors = new Set()) {
    if (ancestors.has(workflow.id))
        return { ready: false, reason: `cycle detected at ${workflow.id}` };
    const nextAncestors = new Set(ancestors).add(workflow.id);
    for (const stage of workflow.stages) {
        for (const dep of stage.dependencies) {
            if (dep.relationship === 'reference')
                continue;
            const child = allMap.get(dep.workflowId);
            if (!child || child.status !== 'active' || child.revision !== dep.revision) {
                return { ready: false, reason: `required dependency ${dep.workflowId}@${dep.revision} is not active or missing` };
            }
            if (child.content.kind !== 'workflow') {
                return { ready: false, reason: `dependency ${dep.workflowId} is not a workflow` };
            }
            const childCheck = checkWorkflowReady(child.content, allMap, nextAncestors);
            if (!childCheck.ready)
                return childCheck;
        }
    }
    return { ready: true };
}
/**
 * Write the current knowledge out as host-readable skills.
 *
 * `only` limits the export to specific entry kinds; by default everything that
 * can be expressed as a skill document is written, because the point is that the
 * host keeps working without this plugin.
 */
export function exportSkills(store, options) {
    const directory = resolve(options.directory);
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
        throw new Error('Export directory must not be a symbolic link');
    }
    const kinds = options.kinds ?? ['workflow', 'skill'];
    const markerPath = join(directory, EXPORT_MARKER);
    const written = [];
    const unchanged = [];
    const skipped = [];
    // Refuse to write into a directory that holds unrelated content: an export
    // must never be capable of overwriting a user's own hand-written skills.
    // An empty directory is allowed — that is the ordinary first-export case.
    if (existsSync(directory) && !existsSync(markerPath)) {
        let existing = [];
        try {
            existing = readdirSync(directory);
        }
        catch {
            existing = ['<unreadable>'];
        }
        if (existing.length > 0) {
            throw new Error(`Refusing to export into ${directory}: it already holds ${existing.length} item(s) and no ${EXPORT_MARKER} marker, so it may contain files this plugin does not own.`);
        }
    }
    const allEntries = store.allEntries();
    const allMap = new Map(allEntries.map(e => [e.id, e]));
    const records = [];
    const sources = new Map(store.adoptions().map(item => [item.knowledgeId, item.sourcePath]));
    const usedFolders = new Set();
    for (const entry of allEntries) {
        if (!kinds.includes(entry.content.kind)) {
            skipped.push({ id: entry.id, reason: `kind ${entry.content.kind} is not exported as a skill` });
            continue;
        }
        if (entry.content.kind === 'workflow') {
            const readyCheck = checkWorkflowReady(entry.content, allMap);
            if (!readyCheck.ready) {
                skipped.push({ id: entry.id, reason: `workflow dependency not ready: ${readyCheck.reason}` });
                continue;
            }
        }
        const sourcePath = sources.get(entry.id);
        let markdown;
        const leaves = [];
        try {
            markdown = renderSkill(entry.content, sourcePath);
            const seen = new Set();
            if (entry.content.kind === 'skill')
                for (const leaf of entry.content.leaves) {
                    const relPath = leafExportPath(leaf.path, sourcePath);
                    const key = relPath.toLowerCase();
                    if (seen.has(key))
                        throw new Error(`Duplicate reference destination: ${relPath}`);
                    seen.add(key);
                    leaves.push({ relPath, body: leaf.body || '' });
                }
        }
        catch (error) {
            skipped.push({ id: entry.id, reason: error instanceof Error ? error.message : 'Invalid reference path' });
            continue;
        }
        if (!markdown) {
            skipped.push({ id: entry.id, reason: 'not representable as a skill document' });
            continue;
        }
        let folder = slug(entry.id, entry.content.title);
        // Two entries can share a title, and a readable name must still be unique.
        while (usedFolders.has(folder))
            folder = `${folder}-${digest(folder + entry.id).slice(0, 4)}`;
        usedFolders.add(folder);
        records.push({ id: entry.id, title: entry.content.title, folder, markdown, leaves });
    }
    if (options.dryRun) {
        const planned = [];
        for (const record of records) {
            planned.push(join(directory, record.folder, 'SKILL.md'));
            for (const leaf of record.leaves) {
                planned.push(join(directory, record.folder, leaf.relPath));
            }
        }
        return { directory, written: planned, unchanged, skipped };
    }
    // Clean up retired entries that were previously exported into this directory
    if (existsSync(markerPath)) {
        try {
            const oldMarker = JSON.parse(readFileSync(markerPath, 'utf8'));
            if (oldMarker && typeof oldMarker.skills === 'object' && oldMarker.skills) {
                for (const oldFolder of Object.keys(oldMarker.skills)) {
                    if (!usedFolders.has(oldFolder)) {
                        const oldDirPath = join(directory, oldFolder);
                        if (oldFolder !== slug(oldMarker.skills[oldFolder]?.id ?? '', oldMarker.skills[oldFolder]?.title))
                            continue;
                        ownedPath(directory, oldDirPath);
                        if (existsSync(oldDirPath)) {
                            rmSync(oldDirPath, { recursive: true, force: true });
                        }
                    }
                }
            }
        }
        catch { }
    }
    mkdirSync(directory, { recursive: true });
    const inventory = {};
    for (const record of records) {
        const folder = join(directory, record.folder);
        const file = join(folder, 'SKILL.md');
        ownedPath(directory, file);
        const hash = digest(record.markdown);
        inventory[record.folder] = { hash, title: record.title, id: record.id };
        if (existsSync(file) && digest(readFileSync(file, 'utf8')) === hash) {
            unchanged.push(file);
        }
        else {
            mkdirSync(folder, { recursive: true });
            writeFileSync(file, record.markdown, 'utf8');
            written.push(file);
        }
        for (const leaf of record.leaves) {
            const leafFile = join(folder, leaf.relPath);
            ownedPath(directory, leafFile);
            const leafHash = digest(leaf.body);
            if (existsSync(leafFile) && digest(readFileSync(leafFile, 'utf8')) === leafHash) {
                unchanged.push(leafFile);
            }
            else {
                mkdirSync(dirname(leafFile), { recursive: true });
                writeFileSync(leafFile, leaf.body, 'utf8');
                written.push(leafFile);
            }
        }
    }
    writeFileSync(markerPath, JSON.stringify({
        format: EXPORT_FORMAT,
        exportedAt: new Date().toISOString(),
        count: records.length,
        skills: inventory,
        note: 'Files in this directory are generated by agent-memory-backpack. They are ordinary SKILL.md documents and remain usable if the plugin is removed.',
    }, null, 2), 'utf8');
    return { directory, written, unchanged, skipped };
}
