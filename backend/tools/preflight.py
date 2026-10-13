"""Read-only dependency/source preflight for the two independent packages."""
import json
from pathlib import Path
import shutil
import subprocess
import sys

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


def check():
    from run import check_dependencies
    check_dependencies(frontend=True)
    frontend = BACKEND.parent / 'frontend'
    package = json.loads((frontend / 'package.json').read_text(encoding='utf-8'))
    if package.get('packageManager') != 'pnpm@11.25.0':
        raise ValueError('前端包管理版本锁定不一致')
    version = subprocess.check_output([shutil.which('node'), '--version'], encoding='ascii').strip().lstrip('v')
    parts = tuple(int(part) for part in version.split('.'))
    if parts < (22, 14, 0) or parts >= (25, 0, 0):
        raise ValueError('前端需要 Node 22.14–24')
    for directory, names in ((frontend, ('pnpm-lock.yaml', 'tsconfig.json', 'vite.config.ts')), (BACKEND, ('requirements.txt', 'run.py', 'app/api.py'))):
        for name in names:
            if not (directory / name).is_file():
                raise ValueError('缺少必要文件：' + str(directory / name))
    subprocess.run(['git', '-C', str(BACKEND.parent), 'diff', '--check'], check=True, capture_output=True)
    return {'ok': True, 'python': sys.version.split()[0], 'frontendNode': version, 'frontendPackageManager': package['packageManager']}


if __name__ == '__main__':
    print(json.dumps(check(), ensure_ascii=False))
