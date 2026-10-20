import { createHash } from 'node:crypto';
import { z } from 'zod';
import { evidenceReferenceSchema, supportSchema } from './schema.js';
import { redactDeep } from './redact.js';

export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export type Support = z.infer<typeof supportSchema>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Freeze supplied evidence at ingestion. No network/file access and no promotion of claims. */
export function captureSupport(origin: Support['origin'], summary = '', references: EvidenceReference[] = [], supplements: Support['supplements'] = []): Support {
  const clean = redactDeep({ summary, references, supplements }, 'support').value;
  const refs = clean.references.map(reference => {
    const { snapshotHash: ignored, ...rest } = reference;
    return { ...rest, ...(rest.snapshot !== undefined ? { snapshotHash: hash(rest.snapshot) } : {}) };
  });
  const status = refs.some(reference => !!reference.snapshot?.trim()) ? 'captured'
    : clean.summary.trim() || refs.length || clean.supplements.length ? 'referenced' : 'missing';
  return supportSchema.parse({ origin, summary: clean.summary, references: refs, supplements: clean.supplements, status,
    snapshotHash: hash(JSON.stringify({ origin, summary: clean.summary, references: refs, supplements: clean.supplements })) });
}

/** Evidence snapshots must not compete with normalized knowledge in retrieval. */
export function retrievalContent<T extends Record<string, unknown>>(content: T): Omit<T, 'support' | 'curation'> {
  const { support, curation, ...rest } = content;
  return rest;
}
