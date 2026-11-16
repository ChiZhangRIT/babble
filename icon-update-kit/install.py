#!/usr/bin/env python3
"""应用已确认的书架与房屋图标；默认只检查，加 --apply 才写入。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from datetime import datetime

KIT = Path(__file__).resolve().parent
digest = lambda data: hashlib.sha256(data).hexdigest()

def prepare(root):
    changes = json.loads((KIT / 'plan.json').read_text())
    pending = []
    for change in changes:
        if change['project'] not in ('virtual-bookshelf', 'house-ledger'):
            raise ValueError('Unknown project')
        project = (root / change['project']).resolve()
        if not (project / 'index.html').is_file():
            raise ValueError(f'Project not found: {project}')
        target = (project / change['path']).resolve()
        if not target.is_relative_to(project):
            raise ValueError('Invalid target path')
        current = target.read_bytes() if target.exists() else None
        current_hash = digest(current) if current is not None else None
        if current_hash == change['after']:
            continue
        if current_hash != change['before']:
            raise ValueError(f'{change["project"]}/{change["path"]} changed after this package was prepared; refresh the package before applying.')
        if 'asset' in change:
            asset = (KIT / change['asset']).resolve()
            if not asset.is_relative_to(KIT / 'assets'):
                raise ValueError('Invalid asset path')
            result = asset.read_bytes()
        else:
            result = current.decode('utf-8')
            for old, new, count in change['replacements']:
                if result.count(old) != count:
                    raise ValueError(f'Replacement does not match: {target}')
                result = result.replace(old, new)
            result = result.encode('utf-8')
        if digest(result) != change['after']:
            raise ValueError(f'Package checksum failed: {target}')
        pending.append((change, target, result))
    return pending

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=KIT.parent.parent, help='Parent directory containing the app projects')
    parser.add_argument('--apply', action='store_true', help='Write changes after all checks pass')
    args = parser.parse_args()
    pending = prepare(args.root.resolve())
    for change, target, result in pending:
        print(f'{change["project"]}/{change["path"]}')
    if not args.apply:
        print(f'Checked {len(pending)} pending files. Add --apply to install.')
        return
    if not pending:
        print('All icons are already installed.')
        return
    backup = KIT / 'backups' / datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    for change, target, result in pending:
        current = target.read_bytes() if target.exists() else None
        if (digest(current) if current is not None else None) != change['before']:
            raise ValueError(f'Target changed during installation: {target}')
        if current is not None:
            saved = backup / change['project'] / change['path']
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, saved)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix='.icon-', dir=target.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(result)
            os.chmod(temporary, target.stat().st_mode & 0o777 if target.exists() else 0o644)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    print(f'Installed {len(pending)} files. Original files: {backup}')

if __name__ == '__main__':
    main()
