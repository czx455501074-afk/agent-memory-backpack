import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DomainError } from './schema.js';
import { BACKUP_MARKER, exportAll, importAll, type BackupExportResult, type BackupImportResult } from './backup.js';
import type { Store } from './store.js';

/**
 * Single-file archive, so a user can carry their backpack to another machine.
 *
 * The directory form (`exportAll`) is the authority: it is what the tests pin
 * down and what the CLI already ships. This module deliberately adds no second
 * validator. An archive is a gzipped tar of exactly those files, and importing
 * one unpacks to a temporary directory and hands it to `importAll`. Anything the
 * directory path refuses — credential-shaped files, a foreign directory, a
 * tampered hash — is refused here for the same reason, from the same code.
 */
export const ARCHIVE_FORMAT = 'agent-memory-backpack-archive-v1';
export const ARCHIVE_EXTENSION = '.ambpack';

/**
 * Ceiling on the decompressed archive.
 *
 * A gzip stream can expand enormously from a small file, so the limit is applied
 * while inflating rather than after: checking the size of a buffer that has
 * already been materialised would be a check that runs too late to help.
 */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

const BLOCK = 512;

/** Octal field, NUL-terminated, as the ustar header requires. */
function octal(value: number, length: number): Buffer {
  const text = value.toString(8).padStart(length - 1, '0').slice(-(length - 1));
  return Buffer.from(text + '\0', 'ascii');
}

function header(name: string, size: number, mtimeSeconds: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  const nameBytes = Buffer.from(name, 'utf8');
  // ustar splits long paths into name + prefix. Tables live at the archive root
  // with short names, so a path that does not fit is a caller error, not
  // something to silently truncate.
  if (nameBytes.length > 100) throw new DomainError('invalid_archive', `Archive entry name is too long: ${name}`);
  nameBytes.copy(block, 0);
  octal(0o644, 8).copy(block, 100);       // mode
  octal(0, 8).copy(block, 108);            // uid
  octal(0, 8).copy(block, 116);            // gid
  octal(size, 12).copy(block, 124);        // size
  octal(mtimeSeconds, 12).copy(block, 136); // mtime
  block.write('        ', 148, 8, 'ascii'); // checksum placeholder
  block.write('0', 156, 1, 'ascii');        // typeflag: regular file
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return block;
}

function padTo512(length: number): number { return (BLOCK - (length % BLOCK)) % BLOCK; }

function isZeroBlock(block: Buffer): boolean { return block.every(byte => byte === 0); }

function parseOctal(block: Buffer, offset: number, length: number): number {
  const text = block.subarray(offset, offset + length).toString('ascii').replace(/\0/g, '').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new DomainError('invalid_archive', 'Archive header field is not octal');
  return Number.parseInt(text, 8);
}

/** Reject anything that could escape the extraction directory. */
export function assertSafeEntryName(name: string): string {
  const normalized = name.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized))
    throw new DomainError('invalid_archive', `Absolute path in archive: ${name}`);
  const segments = normalized.split('/');
  if (segments.some(segment => segment === '..' || segment === ''))
    throw new DomainError('invalid_archive', `Unsafe path in archive: ${name}`);
  return normalized;
}

function tar(entries: Array<{ name: string; body: Buffer }>): Buffer {
  const mtime = Math.floor(Date.now() / 1000);
  const parts: Buffer[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    parts.push(header(entry.name, entry.body.length, mtime));
    parts.push(entry.body);
    const padding = padTo512(entry.body.length);
    if (padding) parts.push(Buffer.alloc(padding));
  }
  // Two zero blocks mark the end of the archive.
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function untar(buffer: Buffer): Array<{ name: string; body: Buffer }> {
  const entries: Array<{ name: string; body: Buffer }> = [];
  let offset = 0;
  const seen = new Set<string>();
  while (offset + BLOCK <= buffer.length) {
    const block = buffer.subarray(offset, offset + BLOCK);
    if (isZeroBlock(block)) break;
    const typeflag = String.fromCharCode(block.subarray(156, 157)[0] ?? 0);
    // Only regular files travel. A directory or link entry would let an archive
    // describe host filesystem structure, which this format has no need for.
    if (typeflag !== '0' && typeflag !== '\0') throw new DomainError('invalid_archive', 'Archive contains a non-file entry');
    const rawName = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const name = assertSafeEntryName(prefix ? `${prefix}/${rawName}` : rawName);
    if (seen.has(name)) throw new DomainError('invalid_archive', `Duplicate archive entry: ${name}`);
    seen.add(name);
    const size = parseOctal(block, 124, 12);
    const start = offset + BLOCK;
    if (start + size > buffer.length) throw new DomainError('invalid_archive', `Truncated archive entry: ${name}`);
    entries.push({ name, body: buffer.subarray(start, start + size) });
    offset = start + size + padTo512(size);
  }
  if (!entries.length) throw new DomainError('invalid_archive', 'Archive holds no files');
  return entries;
}

export interface ArchiveExportResult extends BackupExportResult { file: string; bytes: number; entries: number; }
export interface ArchiveInspectResult {
  file: string; format: unknown; version: unknown; exportedAt: unknown;
  counts: Record<string, number>; entries: string[]; bytes: number;
}
export interface ArchiveImportResult extends BackupImportResult { file: string; entries: number; }

/**
 * Unpack an archive into a fresh temporary directory.
 *
 * The caller owns the directory and must remove it; every export/import path
 * below does so in a `finally`, so a validation failure cannot leave the user's
 * knowledge sitting in the OS temp directory.
 */
function unpackToTemp(file: string): { directory: string; bytes: number; entries: number } {
  const path = resolve(file);
  if (!existsSync(path) || !statSync(path).isFile())
    throw new DomainError('invalid_archive', `Archive not found: ${path}`, 404);
  const raw = readFileSync(path);
  let inflated: Buffer;
  try { inflated = gunzipSync(raw, { maxOutputLength: MAX_ARCHIVE_BYTES }); }
  catch (error) {
    const message = (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'
      ? 'Archive expands beyond the supported size'
      : `Archive is not a readable backpack file: ${(error as Error).message}`;
    throw new DomainError('invalid_archive', message);
  }
  const entries = untar(inflated);
  if (!entries.some(entry => entry.name === BACKUP_MARKER))
    throw new DomainError('invalid_archive', 'Archive is missing its manifest; it is not an Agent Memory Backpack file');
  const directory = mkdtempSync(join(tmpdir(), 'amb-archive-'));
  try {
    for (const entry of entries) writeFileSync(join(directory, entry.name), entry.body);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, bytes: raw.length, entries: entries.length };
}

function withTemp<T>(file: string, run: (directory: string, meta: { bytes: number; entries: number }) => T): T {
  const { directory, bytes, entries } = unpackToTemp(file);
  try { return run(directory, { bytes, entries }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Read the archive's own manifest without touching the knowledge base. */
export function inspectArchive(file: string): ArchiveInspectResult {
  return withTemp(file, (directory, meta) => {
    const manifest = JSON.parse(readFileSync(join(directory, BACKUP_MARKER), 'utf8')) as Record<string, unknown>;
    return {
      file: resolve(file),
      format: manifest.format, version: manifest.version, exportedAt: manifest.exportedAt,
      counts: (manifest.counts ?? {}) as Record<string, number>,
      entries: readdirSync(directory).sort(),
      bytes: meta.bytes,
    };
  });
}

/**
 * Write every authority row into one portable file.
 *
 * The directory export runs first and is the only thing that decides what
 * travels; this function just packs those bytes. Building the archive from the
 * database directly would create a second definition of "everything", and the
 * two would eventually disagree.
 */
export function exportArchive(store: Store, options: { file: string; dryRun?: boolean; overwrite?: boolean }): ArchiveExportResult {
  const file = resolve(options.file);
  if (!file.toLowerCase().endsWith(ARCHIVE_EXTENSION))
    throw new DomainError('invalid_archive', `Archive file must end with ${ARCHIVE_EXTENSION}`);
  // The archive is regenerable from this machine's database, but it is also the
  // only copy of whatever was on the device it came from. Silently replacing a
  // colleague's or a laptop's sole export is the one way this command can lose
  // data no local table holds, so it refuses just as `init` (flag `wx`) and
  // `adopt` (needs `--yes`) refuse to clobber.
  if (existsSync(file) && options.overwrite !== true && options.dryRun !== true)
    throw new DomainError('archive_exists',
      `Refusing to overwrite an existing file: ${file}. Pass --overwrite to replace it, or choose another name.`, 409);
  const workspace = mkdtempSync(join(tmpdir(), 'amb-pack-'));
  try {
    const staged = exportAll(store, { directory: join(workspace, 'backup'), dryRun: false });
    const names = readdirSync(staged.directory).sort();
    const entries = names.map(name => ({ name, body: readFileSync(join(staged.directory, name)) }));
    const packed = gzipSync(tar(entries), { level: 9 });
    if (!options.dryRun) writeFileSync(file, packed);
    return { ...staged, directory: file, file, bytes: packed.length, entries: entries.length,
      written: options.dryRun ? [] : [file] };
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

/** Unpack one archive file and merge it, with every directory-form guarantee intact. */
export function importArchive(store: Store, options: { file: string; dryRun?: boolean; onConflict?: 'skip' | 'fail' }): ArchiveImportResult {
  const file = resolve(options.file);
  return withTemp(file, (directory, meta) => {
    const result = importAll(store, { directory, dryRun: options.dryRun, onConflict: options.onConflict });
    return { ...result, file, entries: meta.entries };
  });
}

/** Default file name, so a user gets a dated archive instead of a bare overwrite risk. */
export function defaultArchiveName(now = new Date()): string {
  // Local components, not the ISO string. Two reasons:
  //  - slicing the ISO string trims the seconds but keeps the milliseconds, producing a
  //    6-digit clock block that no reader of the file name would interpret as HHmmss;
  //  - the ISO string is UTC, so at 03:46 in UTC+8 this names the file with *yesterday's*
  //    date. The whole point of the name is that a human can tell one export from another,
  //    and a human reads their own clock.
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `agent-memory-backpack-${stamp}${ARCHIVE_EXTENSION}`;
}

export function archiveName(file: string): string { return basename(file); }
