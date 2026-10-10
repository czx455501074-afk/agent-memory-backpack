import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Knowledge } from './schema.js';
import type { Store } from './store.js';

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

export interface ExportResult {
  directory: string;
  written: string[];
  unchanged: string[];
  /** Entries skipped, with the reason — never silently dropped. */
  skipped: Array<{ id: string; reason: string }>;
}

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Directory-safe name for one entry.
 *
 * Readable first, unique second: the entry title identifies the folder for a
 * human, and a short hash of the id guarantees two entries with the same title
 * cannot collide. An entry id is already unique, so ids alone would work, but
 * `skill-462df6c36a33307b` tells a user nothing when browsing the tree.
 */
function slug(id: string, title?: string): string {
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
export function renderSkill(entry: Knowledge): string | undefined {
  const lines: string[] = [`# ${entry.title}`, ''];
  if (entry.kind === 'workflow') {
    lines.push(entry.overview, '', '## 触发条件', '');
    for (const trigger of entry.triggers) lines.push(`- ${trigger}`);
    lines.push('', '## 前提', '');
    for (const item of entry.preconditions) lines.push(`- ${item}`);
    lines.push('', '## 步骤', '');
    entry.stages.forEach((stage, index) => {
      lines.push(`${index + 1}. **${stage.title}**（id: ${stage.id}）`, '');
      lines.push(`   ${stage.instructions}`, '');
      lines.push('   检查项：', '');
      for (const check of stage.checks) lines.push(`   - ${check}`);
      if (stage.dependencies.length) {
        lines.push('', '   依赖：');
        for (const dependency of stage.dependencies) {
          lines.push(`   - ${dependency.relationship}: ${dependency.workflowId}@${dependency.revision}`);
        }
      }
      lines.push('');
    });
    lines.push('## 完成判据', '');
    for (const item of entry.completion) lines.push(`- ${item}`);
    lines.push('', '## 失败处理', '', entry.recovery, '');
    if (entry.derivedFrom) {
      lines.push('## 来源', '', `由已采纳技能 ${entry.derivedFrom.skillId}@${entry.derivedFrom.skillRevision} 结构化，整理者：${entry.derivedFrom.derivedBy}。`, '');
    }
  } else if (entry.kind === 'skill') {
    // Verbatim: the adopted text is the user's own wording.
    lines.push(entry.body, '');
    if (entry.leaves.length) {
      lines.push('## 参考文档', '');
      for (const leaf of entry.leaves) lines.push(`- ${leaf.path.split(/[\\/]/).slice(-2).join('/')}`);
      lines.push('');
    }
  } else if (entry.kind === 'norm') {
    lines.push(entry.body, '');
  } else if (entry.kind === 'memory') {
    lines.push(entry.body, '');
  } else {
    return undefined;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Write the current knowledge out as host-readable skills.
 *
 * `only` limits the export to specific entry kinds; by default everything that
 * can be expressed as a skill document is written, because the point is that the
 * host keeps working without this plugin.
 */
export function exportSkills(store: Store, options: {
  directory: string;
  kinds?: Array<Knowledge['kind']>;
  dryRun?: boolean;
}): ExportResult {
  const directory = resolve(options.directory);
  const kinds = options.kinds ?? ['workflow', 'skill'];
  const markerPath = join(directory, EXPORT_MARKER);
  const written: string[] = [];
  const unchanged: string[] = [];
  const skipped: ExportResult['skipped'] = [];

  // Refuse to write into a directory that holds unrelated content: an export
  // must never be capable of overwriting a user's own hand-written skills.
  // An empty directory is allowed — that is the ordinary first-export case.
  if (existsSync(directory) && !existsSync(markerPath)) {
    let existing: string[] = [];
    try { existing = readdirSync(directory); } catch { existing = ['<unreadable>']; }
    if (existing.length > 0) {
      throw new Error(`Refusing to export into ${directory}: it already holds ${existing.length} item(s) and no ${EXPORT_MARKER} marker, so it may contain files this plugin does not own.`);
    }
  }

  const records: Array<{ id: string; title: string; folder: string; markdown: string }> = [];
  const usedFolders = new Set<string>();
  for (const entry of store.allEntries()) {
    if (!kinds.includes(entry.content.kind)) { skipped.push({ id: entry.id, reason: `kind ${entry.content.kind} is not exported as a skill` }); continue; }
    const markdown = renderSkill(entry.content);
    if (!markdown) { skipped.push({ id: entry.id, reason: 'not representable as a skill document' }); continue; }
    let folder = slug(entry.id, entry.content.title);
    // Two entries can share a title, and a readable name must still be unique.
    while (usedFolders.has(folder)) folder = `${folder}-${digest(folder + entry.id).slice(0, 4)}`;
    usedFolders.add(folder);
    records.push({ id: entry.id, title: entry.content.title, folder, markdown });
  }

  if (options.dryRun) {
    return { directory, written: records.map(record => join(directory, record.folder, 'SKILL.md')), unchanged, skipped };
  }

  mkdirSync(directory, { recursive: true });
  const inventory: Record<string, { hash: string; title: string; id: string }> = {};
  for (const record of records) {
    const folder = join(directory, record.folder);
    const file = join(folder, 'SKILL.md');
    const hash = digest(record.markdown);
    inventory[record.folder] = { hash, title: record.title, id: record.id };
    if (existsSync(file) && digest(readFileSync(file, 'utf8')) === hash) { unchanged.push(file); continue; }
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, record.markdown, 'utf8');
    written.push(file);
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
