import assert from 'node:assert/strict';
import { taskSchema, identifier } from '../dist/src/schema.js';
import { toTaskRecord } from '../adapters/dsh/index.mjs';
import { checkShellWriteBypass } from '../adapters/dsh/gate-cache.mjs';
import { checkNodeVersion } from '../adapters/codex/scripts/node-version.mjs';
import naming from '../adapters/dsh/dsh-plugin.naming.json' with { type: 'json' };

console.log('=== VERIFYING DEFECTS AFTER FIX ===');

// 1. BUG-H4: toTaskRecord sanitizes listTask, satisfying taskSchema
const listTask = {
  id: 'task-1',
  projectId: 'proj-1',
  title: 'Test task',
  status: 'in_progress',
  summary: 'A summary',
  notes: 'Some notes',
  knowledgeRevision: 3,
  unfinished: ['step 1'],
  sessionIds: ['sess-1'],
  relatedExperiences: [],
  relatedProposals: [],
  files: ['a.txt'],
  fileStates: [],
  verified: '',
  evidence: 'self-reported',
  startedAt: 123456,
  createdAt: 100000,
  updatedAt: 120000,
  completedAt: null,
};

const sanitizedTask = toTaskRecord(listTask, 'sess-new');
const parseResult = taskSchema.safeParse(sanitizedTask);
console.log('1. BUG-H4 toTaskRecord result parsed by taskSchema:');
console.log('   success:', parseResult.success);
console.log('   sessionIds:', sanitizedTask.sessionIds);

// 2. BUG-H2: referenceId in MCP accepts alpha-style@1
const referenceIdRegex = /^[\p{L}\p{N}_.:-]+(@\d{1,9})?$/u;
console.log('2. BUG-H2 referenceId regex on "alpha-style@1":', referenceIdRegex.test('alpha-style@1'));
console.log('   traversal attempt on "../etc/passwd":', referenceIdRegex.test('../etc/passwd'));

// 3. BUG-H5: checkNodeVersion rejects old/unsupported Node versions
console.log('3. BUG-H5 Node version checks:');
console.log('   Node 20.19.2 (unsupported):', checkNodeVersion('20.19.2').ok);
console.log('   Node 24.18.1 (supported):', checkNodeVersion('24.18.1').ok);
console.log('   Malformed "v" (rejected):', checkNodeVersion('v').ok);

// 4. BUG-H1: checkShellWriteBypass intercepts file write commands when write is denied
console.log('4. BUG-H1 shell write bypass checks:');
const deniedWriteTools = ['apply_patch', 'write', 'edit'];
console.log('   printf "x" > notes.txt:', checkShellWriteBypass('bash', 'printf "x" > notes.txt', deniedWriteTools).denied);
console.log('   echo "x" >> notes.txt:', checkShellWriteBypass('bash', 'echo "x" >> notes.txt', deniedWriteTools).denied);
console.log('   tee notes.txt:', checkShellWriteBypass('bash', 'tee notes.txt', deniedWriteTools).denied);
console.log('   cat notes.txt (read-only):', checkShellWriteBypass('bash', 'cat notes.txt', deniedWriteTools).denied);
console.log('   grep foo bar > /dev/null:', checkShellWriteBypass('bash', 'grep foo bar > /dev/null', deniedWriteTools).denied);

// 5. BUG-M4: DSH naming and adapter tools include amb_search_universal
console.log('5. BUG-M4 DSH naming includes amb_search_universal:', naming.names.tools.includes('amb_search_universal'));

console.log('=== END OF VERIFICATION AFTER ===');
