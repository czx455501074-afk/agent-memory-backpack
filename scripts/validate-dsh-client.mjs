import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';

// DSH loads client.js as a classic browser script, outside the TypeScript build.
// Compile the exact bytes before copying an artifact into a live installation.
export function validateDshClient(directory) {
  const filename = join(directory, 'client.js');
  new Script(readFileSync(filename, 'utf8'), { filename });
}
