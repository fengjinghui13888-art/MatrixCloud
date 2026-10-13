"""Preview or explicitly apply image compression; retain all original hash files."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import sys
from PIL import Image, ImageOps

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


def compress(settings, workspace='owner', apply=False):
    from app.services import Services
    from app.store import atomic_write
    from app.templates import decode_template_image
    services = Services(settings)
    try:
        scope = services.for_workspace(workspace)
        rows = scope.templates.list()
        if any(task['status'] in ('generating', 'approved', 'filling') for task in scope.studio.list()):
            raise ValueError('有任务正在运行，请等待后重试')
        backup = scope.root / 'maintenance' / ('template-compression-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        if apply:
            atomic_write(backup / 'templates-before.json', json.dumps(rows, ensure_ascii=False, indent=2).encode('utf-8'))
        report = []
        for row in rows:
            draft = row['draft']
            if row['published'] or draft['sourceUrl'] != '' or draft['rightsNote'] != '客户本地上传' or len(draft['images']) != 1:
                continue
            original_url = draft['images'][0]
            key = original_url.rsplit('/', 1)[-1]
            if not re.fullmatch(r'[a-f0-9]{64}\.jpg', key):
                continue
            path = scope.templates.file(key)
            if not path:
                raise ValueError('原图不存在')
            original = path.read_bytes()
            if len(original) < 1.5 * 1024 * 1024:
                continue
            if hashlib.sha256(original).hexdigest() != key[:64]:
                raise ValueError('原图校验失败')
            with Image.open(io.BytesIO(original)) as image:
                if image.width * image.height > 80_000_000:
                    raise ValueError('图片尺寸超出解码限制')
                image = ImageOps.exif_transpose(image).convert('RGB')
                image.thumbnail((2560, 2560))
                output = io.BytesIO()
                image.save(output, 'JPEG', quality=86, subsampling=2)
                blob = output.getvalue()
                width, height = image.size
            if len(blob) >= len(original) * .9:
                continue
            blob, new_key = decode_template_image('data:image/jpeg;base64,' + base64.b64encode(blob).decode('ascii'))
            url = '/api/templates/media/' + new_key
            entry = dict(id=row['id'], name=draft['name'], originalUrl=original_url, url=url, before=len(original), after=len(blob), width=width, height=height, applied=False)
            report.append(entry)
            if apply:
                atomic_write(path.parent / new_key, blob)
                scope.templates.update(row['id'], {**draft, 'images': [url]}, row['revision'])
                entry['applied'] = True
                atomic_write(backup / 'report.json', json.dumps(report, ensure_ascii=False, indent=2).encode('utf-8'))
        if apply:
            after = scope.templates.list()
            if any(not any(row['id'] == entry['id'] and row['draft']['images'][0] == entry['url'] for row in after) for entry in report):
                raise ValueError('模板引用校验失败')
        return {'apply': apply, 'backup': str(backup) if apply else None, 'count': len(report), 'entries': report}
    finally:
        services.close()


if __name__ == '__main__':
    from app.settings import Settings, load_env_file
    load_env_file()
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', default='owner')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(compress(Settings.from_env(), args.workspace, args.apply), ensure_ascii=False, indent=2))
