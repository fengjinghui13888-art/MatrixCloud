from pathlib import Path
import zipfile

from tools.maintenance import package


def test_source_archive_contains_both_packages_without_private_data(tmp_path):
    for name in ('frontend/src/App.tsx', 'frontend/package.json', 'frontend/pnpm-lock.yaml',
                 'backend/app/main.py', 'backend/requirements.txt', 'backend/.env.example',
                 'backend/data/accounts.sqlite', 'backend/data/access-token',
                 'backend/.venv/runtime.py', 'frontend/node_modules/dependency.js',
                 'backend/integration/yingdao.local.json', 'backend/.env', 'backend/secret.enc'):
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('fixture', encoding='utf-8')
    target = tmp_path.parent / (tmp_path.name + '.zip')
    package(tmp_path, target)
    with zipfile.ZipFile(target) as archive:
        assert set(archive.namelist()) == {'frontend/src/App.tsx', 'frontend/package.json',
            'frontend/pnpm-lock.yaml', 'backend/app/main.py', 'backend/requirements.txt', 'backend/.env.example'}
