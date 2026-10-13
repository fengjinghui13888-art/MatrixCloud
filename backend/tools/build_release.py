"""Build a source release without credentials, private data or deployment actions."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
from tools.maintenance import package


def build(output, cloud_url):
    output = Path(output).resolve()
    origin = urlsplit(cloud_url)
    if origin.scheme != 'https' or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment or origin.path not in ('', '/'):
        raise ValueError('必须使用无凭证的 HTTPS 工作台地址')
    if output.exists():
        raise ValueError('输出目录已存在，拒绝覆盖')
    output.mkdir(parents=True)
    result = package(BACKEND.parent, output / 'matrix-cloud-source.zip')
    revision = subprocess.check_output(['git', '-C', str(BACKEND.parent), 'rev-parse', 'HEAD'], text=True).strip()
    manifest = {**result, 'revision': revision, 'cloudUrl': cloud_url.rstrip('/'), 'runtime': 'python-3.13', 'deployed': False}
    (output / 'MANIFEST.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cloud-url', required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.output, args.cloud_url), ensure_ascii=False))
