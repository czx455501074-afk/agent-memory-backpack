"""Copy the installed desktop's exact dsh runtime to an isolated test fixture.

No install scripts are run. The desktop archive and profile remain read-only.
Usage: python scripts/extract-dsh-runtime.py APP_ASAR OUTPUT_DIRECTORY
"""
import hashlib
import json
from pathlib import Path
import shutil
import struct
import sys

archive = Path(sys.argv[1]).resolve(strict=True)
target = Path(sys.argv[2]).resolve()
if target.exists():
    raise SystemExit('Output already exists; refusing to overwrite a runtime fixture.')
unpacked = Path(str(archive) + '.unpacked').resolve()
with archive.open('rb') as source:
    prefix = struct.unpack('<4I', source.read(16))
    if prefix[3] > 64 * 1024 * 1024:
        raise SystemExit('Unexpected ASAR header size')
    header = json.loads(source.read(prefix[3]))
    content_start = 8 + prefix[1]
    root = header['files']['dsh']
    entries = []
    def walk(node, suffix):
        if 'link' in node:
            raise ValueError('Archive links require explicit review: ' + str(suffix))
        if 'files' in node:
            for name, child in node['files'].items():
                walk(child, suffix / name)
        else:
            destination = (target / suffix).resolve()
            if not destination.is_relative_to(target):
                raise ValueError('Archive entry escapes fixture')
            entries.append((node, suffix, destination))
    walk(root, Path())
    target.mkdir(parents=True)
    for node, suffix, destination in entries:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if node.get('unpacked'):
            original = (unpacked / 'dsh' / suffix).resolve(strict=True)
            if not original.is_relative_to(unpacked):
                raise ValueError('Unpacked entry escapes source')
            shutil.copyfile(original, destination)
        else:
            source.seek(content_start + int(node['offset']))
            data = source.read(node['size'])
            if len(data) != node['size']:
                raise ValueError('Truncated archive entry')
            destination.write_bytes(data)
with archive.open('rb') as source:
    digest = hashlib.file_digest(source, 'sha256').hexdigest()
(target / 'amb-runtime-source.json').write_text(json.dumps({
    'archive': str(archive), 'sha256': digest, 'files': len(entries),
    'scope': 'dsh subtree; test fixture only; no host modification',
}, indent=2), encoding='utf-8')
print(f'Extracted {len(entries)} runtime files to {target}')
