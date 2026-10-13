"""Offline PG media references. A stopped business container is required."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


def snapshot(settings, output, container='matrix-cloud'):
    from app.postgres import Postgres
    from app.store import atomic_write
    if not re.fullmatch(r'[\w.-]+', container) or subprocess.check_output(['docker', 'inspect', '--format={{.State.Running}}', container], text=True).strip() != 'false':
        raise ValueError('媒体引用检查要求业务容器已停止')
    if not settings.database_url:
        raise ValueError('需要数据库配置')
    db = Postgres(settings.database_url)
    files = set()
    def visit(value, tenant):
        if isinstance(value, str):
            match = re.fullmatch(r'/api/templates/media/([a-f0-9]{64}\.(png|jpg|webp))', value)
            if match:
                files.add('template-uploads/' + tenant + '/' + match[1])
        elif isinstance(value, list):
            for item in value:
                visit(item, tenant)
        elif isinstance(value, dict):
            for key, item in value.items():
                if key == 'path' and isinstance(item, str) and '..' not in item and not item.startswith('/'):
                    files.add(('' if tenant == 'owner' else 'workspaces/' + tenant + '/') + 'media/' + item)
                else:
                    visit(item, tenant)
    try:
        with db._connection() as connection:
            tenants = [row['tenant_id'] for row in connection.execute('SELECT tenant_id FROM tenant')]
        for tenant in tenants:
            with db.transaction(tenant) as connection:
                active = connection.execute("SELECT 1 FROM job WHERE tenant_id=%s AND status IN ('running','queued','stopping') UNION ALL SELECT 1 FROM generation WHERE tenant_id=%s AND status IN ('generating','filling') LIMIT 1", (tenant, tenant)).fetchone()
                if active:
                    raise ValueError('仍有活动任务，禁止清理')
                for table in ('note', 'asset', 'template', 'generation'):
                    for row in connection.execute(f'SELECT to_jsonb(t) AS data FROM {table} t WHERE tenant_id=%s', (tenant,)):
                        visit(row['data'], tenant)
        result = {'format': 1, 'source': 'postgres', 'offline': True, 'createdAt': int(time.time() * 1000), 'files': sorted(files)}
        atomic_write(Path(output), json.dumps(result, ensure_ascii=False, indent=2).encode('utf-8'))
        return result
    finally:
        db.close()


if __name__ == '__main__':
    from app.settings import Settings, load_env_file
    load_env_file()
    parser = argparse.ArgumentParser()
    parser.add_argument('output', type=Path)
    parser.add_argument('--container', default=os.getenv('MATRIX_CONTAINER', 'matrix-cloud'))
    args = parser.parse_args()
    print(json.dumps(snapshot(Settings.from_env(), args.output, args.container), ensure_ascii=False))
