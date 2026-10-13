"""Read-only bounded developer context. No provider or customer data access."""
import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
MODULES = {
    'creation': {'source': ['frontend/src/OneClickPublish.tsx', 'backend/app/studio.py', 'backend/app/queues.py'], 'tests': ['backend/tests/test_services_business.py', 'frontend/src/__tests__/studio-ui.test.tsx']},
    'execution': {'source': ['backend/app/sync.py', 'backend/connector/draft.py', 'backend/connector/server.py'], 'tests': ['backend/tests/test_connector_runtime.py']},
    'maintenance': {'source': ['backend/app/maintenance.py', 'backend/tools/maintenance.py'], 'tests': ['backend/tests/test_api_maintenance.py', 'backend/tools/tests/test_maintenance.py']},
}


def context(module=None):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(ROOT), *args], encoding='utf-8', errors='replace').strip()
    changes = git('status', '--short').splitlines()
    return {'revision': git('rev-parse', '--short', 'HEAD'), 'branch': git('branch', '--show-current'),
            'changes': changes[:30], 'omittedChanges': max(0, len(changes) - 30),
            'diff': git('diff', 'HEAD', '--stat')[:1800],
            'modules': {module: MODULES[module]} if module else MODULES,
            'handoff': 'backend/docs/migration/ledger.md',
            'boundaries': '保留原生图、文案供应商及费用设置、素材二创与已上传原图；单任务支持1–12张。'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('module', nargs='?', choices=MODULES)
    print(json.dumps(context(parser.parse_args().module), ensure_ascii=False, indent=2))
