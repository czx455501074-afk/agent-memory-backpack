import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Scope } from './schema.js';

export interface ScanScopeContext { projectId: string; projectRoot: string; globalRoots?: string[]; explicitProject?: boolean }
const canonical = (path: string) => existsSync(path) ? realpathSync(path) : resolve(path);
const within = (root: string, path: string) => {
  const rel = relative(canonical(root), canonical(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Source location and authenticated configuration, never imperative prose. */
export function sourceScope(path: string, context: ScanScopeContext, kind?: string): { scope: Scope; basis: string; requiresReview?: boolean } {
  const globalRoots = context.globalRoots ?? [
    ...['.codex', '.dsh', '.agents'].flatMap(name => [join(homedir(), name), join(homedir(), name, 'skills'), join(homedir(), name, 'memories')]),
    ...(process.env.DSH_HOME ? [process.env.DSH_HOME, join(process.env.DSH_HOME, '.agents')] : []),
  ];
  if (globalRoots.some(root => within(root, path))) {
    // A shared memories folder is a storage location, not proof every fact applies everywhere.
    if (kind === 'memory' || kind === 'journal') return { scope: { kind: 'project', projectId: context.projectId },
      basis: context.explicitProject ? 'explicit_project_import' : 'shared_history_requires_project_attribution',
      ...(!context.explicitProject ? { requiresReview: true } : {}) };
    return { scope: { kind: 'global' }, basis: 'source_under_configured_user_agent_root' };
  }
  return { scope: { kind: 'project', projectId: context.projectId },
    basis: within(context.projectRoot, path) ? 'source_under_project_root' : 'explicit_import_into_project_unknown_global_ownership' };
}

/** Read identity only; credentials never leave this function or enter reports. */
export function scanContextFromDisk(dir: string, fallback: ScanScopeContext): ScanScopeContext {
  for (const name of ['codex-client.json', 'dsh-client.json', 'client.json']) {
    try {
      const client = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (typeof client.projectId === 'string' && client.projectId.trim()) return {
        projectId: fallback.explicitProject ? fallback.projectId : client.projectId,
        projectRoot: typeof client.projectRoot === 'string' ? client.projectRoot : fallback.projectRoot,
        explicitProject: fallback.explicitProject,
      };
    } catch { /* an unavailable file supplies no identity */ }
  }
  return fallback;
}
