import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { identifier } from './schema.js';

export const defaultDataDir = () => join(homedir(), '.agent-memory-backpack');
/**
 * A credential's role decides what it may do.
 *
 * `adapter` is an agent's identity: it reads knowledge and submits candidates.
 * `admin` is the human's: only it may list, approve or reject proposals, or
 * change review policy. Separating them is what makes "an agent may propose but
 * must not approve its own proposal" enforceable rather than advisory — with a
 * single shared credential the agent could always call the approval endpoint.
 */
export const roleSchema = z.enum(['adapter', 'admin']);
export const clientSchema = z.object({
  endpoint: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  }, 'Core endpoint must be a loopback HTTP origin'),
  token: z.string().min(32).max(256), projectId: identifier, projectRoot: z.string().min(1).optional(),
  role: roleSchema.default('adapter'),
}).strict();
export const coreSchema = z.object({
  protocolVersion: z.literal(1), port: z.number().int().min(1).max(65535),
  clients: z.array(z.object({
    id: z.enum(['codex', 'dsh', 'admin']),
    token: z.string().min(32).max(256), projectId: identifier,
    role: roleSchema.default('adapter'),
  }).strict()).min(1),
}).strict();
export type ClientConfig = z.infer<typeof clientSchema>;
export type CoreConfig = z.infer<typeof coreSchema>;
export type Role = z.infer<typeof roleSchema>;
export function readClientConfig(path = process.env.AMB_CONFIG ?? join(defaultDataDir(), 'client.json')): ClientConfig {
  try { return clientSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { throw new Error('Agent Memory Backpack client configuration missing or invalid. Run init; set AMB_CONFIG to the generated adapter config.'); }
}
