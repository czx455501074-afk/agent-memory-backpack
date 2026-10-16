import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
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
    autoCaptureFailures: z.boolean().optional(),
    autoCaptureMaterial: z.boolean().optional(),
    autoReflect: z.boolean().optional(),
    role: roleSchema.default('adapter'),
}).strict();
export const coreSchema = z.object({
    protocolVersion: z.literal(1), port: z.number().int().min(1).max(65535),
    clients: z.array(z.object({
        id: z.enum(['codex', 'dsh', 'admin']),
        token: z.string().min(32).max(256), projectId: identifier,
        role: roleSchema.default('adapter'),
    }).strict()).min(1),
}).strict().superRefine((val, ctx) => {
    const ids = new Set();
    const tokens = new Set();
    for (let i = 0; i < val.clients.length; i++) {
        const client = val.clients[i];
        if (ids.has(client.id)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Duplicate client id: ${client.id}. Each client must have a unique id.`,
                path: ['clients', i, 'id'],
            });
        }
        ids.add(client.id);
        if (tokens.has(client.token)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Duplicate client token. Each client must have a distinct token.',
                path: ['clients', i, 'token'],
            });
        }
        tokens.add(client.token);
    }
});
function explicitCandidates(adapterId, env) {
    const candidates = [];
    if (adapterId === 'dsh' && typeof env.AMB_DSH_CONFIG === 'string' && env.AMB_DSH_CONFIG.trim()) {
        candidates.push({ name: 'AMB_DSH_CONFIG', value: env.AMB_DSH_CONFIG.trim() });
    }
    if (typeof env.AMB_CONFIG === 'string' && env.AMB_CONFIG.trim()) {
        candidates.push({ name: 'AMB_CONFIG', value: env.AMB_CONFIG.trim() });
    }
    return candidates;
}
export function resolveConfigPath(adapterId, env = process.env) {
    const dir = defaultDataDir();
    const own = join(dir, adapterId + '-client.json');
    // Older installs wrote the Codex credential to a bare client.json.
    const legacy = join(dir, 'client.json');
    for (const candidate of explicitCandidates(adapterId, env)) {
        const named = resolve(candidate.value);
        if (existsSync(named))
            return { path: named, warning: null };
        const fallback = existsSync(own) ? own : legacy;
        const warning = `${candidate.name} points at ${named}, which does not exist; using ${fallback} instead.`;
        return { path: fallback, warning };
    }
    if (existsSync(own))
        return { path: own, warning: null };
    /**
     * The legacy shared file is adopted, but never silently.
     *
     * `client.json` is documented above as where an older install wrote the *Codex*
     * credential, so falling back to it can hand this end another adapter's identity:
     * the file carries the endpoint, the token, the project and the role, and a
     * different project or an `admin` role would change what this end may do. The
     * fallback is kept because refusing would break installs that predate the
     * per-adapter files, but a resolution that is not the adapter's own file is a
     * degraded one and has to say so — the explicit-pointer case above already warns,
     * and this path warned about nothing at all.
     */
    if (existsSync(legacy)) {
        return {
            path: legacy,
            warning: `No ${adapterId}-client.json in ${dir}; using the legacy shared client.json, which an older install wrote for the other adapter. This end may then act under that file's project or role. Run init to write a dedicated credential.`,
        };
    }
    return { path: own, warning: null };
}
export function readClientConfig(path, adapterId = 'codex') {
    const resolved = resolveConfigPath(adapterId, process.env);
    const target = path ?? resolved.path;
    if (!path && resolved.warning)
        process.stderr.write('Agent Memory Backpack: ' + resolved.warning + '\n');
    try {
        return clientSchema.parse(JSON.parse(readFileSync(target, 'utf8')));
    }
    catch {
        throw new Error('Agent Memory Backpack client configuration missing or invalid: ' + target
            + '. Run init, or set AMB_CONFIG to a generated adapter config.');
    }
}
