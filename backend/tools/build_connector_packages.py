"""Package Python connectors from separately verified per-platform runtimes."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import sys
from urllib.parse import urlsplit
import zipfile

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
from app.protocols import CONNECTOR_PLATFORMS


def build(runtime_root, output_dir, platform, cloud_url, candidate=False):
    mapping = next((row for row in CONNECTOR_PLATFORMS if row['id'] == platform), None)
    if not mapping:
        raise ValueError('不支持的平台')
    origin = urlsplit(cloud_url)
    if origin.scheme != 'https' or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment or origin.path not in ('', '/'):
        raise ValueError('连接器发行包需要无凭证的 HTTPS 工作台地址')
    runtime = Path(runtime_root).resolve() / mapping['source']
    metadata_file = runtime / 'runtime-metadata.json'
    if not metadata_file.is_file():
        raise ValueError('缺少经核验的 Python 运行时元数据')
    metadata = json.loads(metadata_file.read_text(encoding='utf-8'))
    version = metadata.get('pythonVersion', '')
    if not re.fullmatch(r'3\.(?:1[3-9]|[2-9][0-9])\.\d+', version) or metadata.get('platform') != platform or not metadata.get('officialArchiveSha256'):
        raise ValueError('运行时平台、版本或官方归档校验值无效')
    if not candidate and (not metadata.get('verified') or platform.startswith('mac') and (not metadata.get('signed') or not metadata.get('notarized'))):
        raise ValueError('运行时未完成核验或签名/公证，请仅使用 --candidate 生成待验候选包')
    windows = platform.startswith('windows')
    binary_name = 'runtime/python/python.exe' if windows else 'runtime/python/bin/python3'
    if not (runtime / binary_name).is_file() or not (runtime / 'runtime/python/LICENSE').is_file() or not (runtime / 'runtime/site-packages').is_dir():
        raise ValueError('Python 可携带运行时或依赖不完整')
    files = {}
    for folder in ('runtime/python', 'runtime/site-packages'):
        for path in (runtime / folder).rglob('*'):
            if path.is_symlink():
                raise ValueError('运行时含符号链接，请供应展开后的已核验文件')
            if path.is_file() and '__pycache__' not in path.parts:
                files[path.relative_to(runtime).as_posix()] = path.read_bytes()
    hashes = metadata.get('files', {})
    if not isinstance(hashes, dict) or set(hashes) != set(files):
        raise ValueError('运行时文件清单不完整')
    for name, content in files.items():
        if hashlib.sha256(content).hexdigest() != hashes[name]:
            raise ValueError('运行时文件哈希不匹配：' + name)
    for path in (BACKEND / 'connector').rglob('*.py'):
        files[path.relative_to(BACKEND).as_posix()] = path.read_bytes()
    files['app/__init__.py'] = b''
    files['app/protocols.py'] = (BACKEND / 'app/protocols.py').read_bytes()
    files['connector-config.json'] = json.dumps({'cloudUrl': cloud_url.rstrip('/'), 'protocol': 4}, ensure_ascii=False).encode('utf-8')
    files['launch.py'] = b'''import json,sys\nfrom pathlib import Path\nroot=Path(__file__).resolve().parent\nsys.path.insert(0,str(root))\nsys.path.insert(0,str(root/'runtime'/'site-packages'))\nfrom connector.__main__ import main\nconfig=json.loads((root/'connector-config.json').read_text(encoding='utf-8'))\nmain(['--cloud-url',config['cloudUrl'],'--onboard',*sys.argv[1:]])\n'''
    if windows:
        files['START-CONNECTOR.bat'] = '@echo off\r\nchcp 65001 >nul\r\n"%~dp0runtime\\python\\python.exe" -X utf8 "%~dp0launch.py" %*\r\nif errorlevel 1 pause\r\n'.encode('utf-8')
        files['PAIR-CONNECTOR.bat'] = '@echo off\r\ncall "%~dp0START-CONNECTOR.bat" --pair\r\n'.encode('utf-8')
    else:
        suffix = 'command' if platform.startswith('mac') else 'sh'
        files['START-CONNECTOR.' + suffix] = b'#!/bin/sh\nset -eu\nBASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$BASE/runtime/python/bin/python3" -X utf8 "$BASE/launch.py" "$@"\n'
        files['PAIR-CONNECTOR.' + suffix] = b'#!/bin/sh\nset -eu\nBASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$BASE/runtime/python/bin/python3" -X utf8 "$BASE/launch.py" --pair\n'
    files['README.md'] = ('矩阵云 Python 连接器，协议4。双击 START-CONNECTOR 完成授权。数据保存在用户目录 .matrix-cloud；请勿删除凭证和浏览器配置。\n' + ('此包为待验候选，真实系统、账号流程与签名验收未完成。\n' if candidate else '')).encode('utf-8')
    manifest = {'format': 3, 'platform': platform, 'cloudUrl': cloud_url.rstrip('/'), 'candidate': candidate,
                'runtime': {key: value for key, value in metadata.items() if key != 'files'},
                'files': [{'path': name, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()} for name, content in sorted(files.items())]}
    files['MANIFEST.json'] = json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8')
    output = Path(output_dir).resolve() / mapping['filename']
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise ValueError('发行包已存在，拒绝覆盖')
    temporary = output.with_suffix('.zip.part')
    if temporary.exists():
        raise ValueError('存在未完成发行包，请先核查')
    try:
        with zipfile.ZipFile(temporary, 'x', zipfile.ZIP_DEFLATED) as archive:
            for name, content in sorted(files.items()):
                info = zipfile.ZipInfo(mapping['source'] + '/' + name, date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                mode = 0o755 if name == binary_name or name.endswith(('.command', '.sh')) else 0o644
                info.external_attr = (stat.S_IFREG | mode) << 16
                archive.writestr(info, content)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return {'path': str(output), 'bytes': output.stat().st_size, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'candidate': candidate}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime-root', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--cloud-url', required=True)
    parser.add_argument('--platform', choices=[row['id'] for row in CONNECTOR_PLATFORMS], required=True)
    parser.add_argument('--candidate', action='store_true')
    args = parser.parse_args()
    print(json.dumps(build(args.runtime_root, args.output_dir, args.platform, args.cloud_url, args.candidate), ensure_ascii=False))
