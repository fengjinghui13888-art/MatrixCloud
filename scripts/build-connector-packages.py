#!/usr/bin/env python3
"""Build customer connector ZIPs with UTF-8 filenames and an integrity manifest.

The old release was made with a macOS archive tool: it added __MACOSX entries,
omitted the bundled Windows runtime, and encoded the Chinese .bat names in a
way that Windows Explorer displayed as damaged text. This builder deliberately
uses ASCII launch names and ZIP's UTF-8 flag so every customer gets a usable
archive.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
PLATFORMS = {
    'windows': ('windows-connector', 'matrix-cloud-windows-connector.zip'),
    'mac-intel': ('mac-connector-x64', 'matrix-cloud-mac-intel-connector.zip'),
    'mac-arm64': ('mac-connector-arm64', 'matrix-cloud-mac-apple-silicon-connector.zip'),
    'windows-arm64': ('windows-connector-arm64', 'matrix-cloud-windows-arm64-connector.zip'),
    'windows-x86': ('windows-connector-x86', 'matrix-cloud-windows-x86-connector.zip'),
    'linux-x64': ('linux-connector-x64', 'matrix-cloud-linux-x64-connector.zip'),
    'linux-arm64': ('linux-connector-arm64', 'matrix-cloud-linux-arm64-connector.zip'),
}
CUSTOMER_ENTRIES = ('local-connector/launch.mjs', 'local-connector/connector.mjs',
                    'local-connector/pair.mjs', 'local-connector/sync-worker.mjs', 'scripts/studio-executor.mjs')
DEPENDENCIES = ('playwright-core', 'ws')
RUNTIME_METADATA_FIELDS = ('version', 'nodeVersion', 'platform', 'arch', 'archive',
                           'archiveSha256', 'sourceUrl', 'sha256Verified', 'binarySha256')
IMPORT_PATTERNS = (
    re.compile(r'\b(?:import|export)\s+[^;]*?\bfrom\s*([\'"])([^\'"]+)\1', re.S),
    re.compile(r'\bimport\s*([\'"])([^\'"]+)\1'),
    re.compile(r'\bimport\s*\(\s*([\'"])([^\'"]+)\1'),
)


def files_for(folder: pathlib.Path):
    for path in sorted(folder.rglob("*")):
        if not path.is_file():
            continue
        if path.name == 'MANIFEST.json' or any(part in ('.DS_Store', '__MACOSX', '.git') for part in path.parts):
            continue
        yield path


def verify_macos_runtime(binary: pathlib.Path, allow_unsigned: bool):
    if allow_unsigned:
        return {"signed": None, "notarized": False, "signatureVerification": "not-verified", "reason": "allow-unsigned-candidate"}
    if sys.platform != 'darwin' or shutil.which("codesign") is None:
        raise SystemExit("Mac 发布包必须在 macOS 上用 codesign 校验；待验候选可显式传 --allow-unsigned")
    result=subprocess.run(["codesign","--verify","--deep","--strict",str(binary)],capture_output=True,text=True)
    if result.returncode:
        raise SystemExit("Mac Node 运行时未通过 Developer ID 签名校验；请使用签名运行时或显式传 --allow-unsigned")
    detail=subprocess.run(["codesign","-dv","--verbose=4",str(binary)],capture_output=True,text=True)
    text=detail.stderr+detail.stdout
    if "Developer ID Application:" not in text:
        raise SystemExit("Mac Node 运行时不是 Developer ID 签名；请使用正式签名运行时或显式传 --allow-unsigned")
    return {"signed": True, "notarized": False, "signatureVerification": "codesign", "identity": next((line.split(':',1)[1].strip() for line in text.splitlines() if line.startswith('Authority=Developer ID Application:')), None)}


def customer_modules(root=ROOT):
    """Follow literal relative imports; child-process entry points are explicit."""
    root = root.resolve()
    pending = [root / name for name in CUSTOMER_ENTRIES]
    result = {}
    while pending:
        path = pending.pop().resolve()
        try:
            name = path.relative_to(root).as_posix()
        except ValueError:
            raise SystemExit('客户模块导入不能离开源码目录')
        if name in result:
            continue
        if path.suffix not in ('.mjs', '.js', '.json') or name.split('/')[0] not in ('local-connector', 'scripts', 'shared'):
            raise SystemExit('客户模块导入不在代码白名单：' + name)
        if not path.is_file():
            raise SystemExit('客户模块导入缺失：' + name)
        result[name] = path
        if path.suffix == '.json':
            continue
        source = path.read_text(encoding='utf-8')
        for pattern in IMPORT_PATTERNS:
            for match in pattern.finditer(source):
                specifier = match.group(2)
                if specifier.startswith('.'):
                    pending.append(path.parent / specifier)
                elif not specifier.startswith('node:') and specifier.split('/')[0] not in DEPENDENCIES:
                    raise SystemExit('客户模块依赖未列入白名单：' + specifier)
    return result


def runtime_version(node_folder):
    """Read verified distribution metadata without executing another CPU's Node."""
    versions = []
    version_file = node_folder / 'VERSION'
    if version_file.is_file():
        versions.append(version_file.read_text(encoding='utf-8').strip().removeprefix('v'))
    metadata_file = node_folder / 'runtime-metadata.json'
    if metadata_file.is_file():
        metadata = json.loads(metadata_file.read_text(encoding='utf-8'))
        value = metadata.get('nodeVersion', metadata.get('version'))
        if value:
            versions.append(str(value).removeprefix('v'))
    header = node_folder / 'include' / 'node' / 'node_version.h'
    if not versions and header.is_file():
        text = header.read_text(encoding='utf-8')
        components = [re.search(r'#define\s+NODE_' + part + r'_VERSION\s+(\d+)', text) for part in ('MAJOR', 'MINOR', 'PATCH')]
        if all(components):
            versions.append('.'.join(value.group(1) for value in components))
    if not versions or any(not re.fullmatch(r'\d+\.\d+\.\d+', value) for value in versions) or len(set(versions)) != 1:
        raise SystemExit('Node 运行时缺少有效且一致的 VERSION / runtime-metadata.json 版本元数据：' + str(node_folder))
    return versions[0]

def build(source: str, output: pathlib.Path, platform: str, runtime_root=ROOT, cloud_url=None, node_runtime_root=None, allow_unsigned=False):
    folder = runtime_root / source
    windows = platform.startswith('windows')
    macos = platform.startswith('mac')
    candidate = (macos and allow_unsigned) or platform in ('windows-arm64', 'windows-x86', 'linux-x64', 'linux-arm64')
    node_folder = (node_runtime_root or runtime_root) / source / 'runtime' / 'node'
    binary_name = 'node.exe' if windows else 'bin/node'
    binary = node_folder / binary_name
    required = [binary, node_folder / 'LICENSE'] + [folder / 'node_modules' / dependency / 'package.json' for dependency in DEPENDENCIES]
    missing = [str(p) for p in required if not p.is_file()]
    if missing:
        raise SystemExit("缺少交付文件：" + ", ".join(missing))
    candidates = customer_modules()
    runtime_meta = {"nodeVersion": runtime_version(node_folder), "signed": None, "notarized": False, "signatureVerification": "not-verified"}
    if macos:
        runtime_meta.update(verify_macos_runtime(binary, allow_unsigned))
    for name in (binary_name, 'LICENSE', 'VERSION', 'runtime-metadata.json'):
        path = node_folder / name
        if path.is_file():
            candidates['runtime/node/' + name] = path
    dependencies = {}
    for dependency in DEPENDENCIES:
        dependency_folder = folder / 'node_modules' / dependency
        dependencies[dependency] = json.loads((dependency_folder / 'package.json').read_text(encoding='utf-8'))['version']
        for path in files_for(dependency_folder):
            relative = path.relative_to(dependency_folder)
            if any(part.startswith('.env') or part in ('.npmrc', 'cloud-device.json', 'connector-token', 'chrome-profile') or part.endswith(('.key', '.pem')) for part in relative.parts):
                raise SystemExit('依赖目录含非交付文件：' + dependency + '/' + relative.as_posix())
            candidates['node_modules/' + dependency + '/' + relative.as_posix()] = path
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_suffix(output.suffix + '.tmp')
    manifest = []
    with zipfile.ZipFile(temporary_output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        # Launchers are maintained in source, not inherited from an old release.
        overrides={'connector-config.json':json.dumps({'cloudUrl':cloud_url}).encode()}
        metadata_file = node_folder / 'runtime-metadata.json'
        if metadata_file.is_file():
            metadata = json.loads(metadata_file.read_text(encoding='utf-8'))
            public_metadata = {key: value for key, value in metadata.items() if key in RUNTIME_METADATA_FIELDS and isinstance(value, (str, bool, int, float))}
            overrides['runtime/node/runtime-metadata.json'] = (json.dumps(public_metadata, ensure_ascii=False, indent=2) + '\n').encode()
        overrides['package.json'] = json.dumps({'name': 'matrix-cloud-customer-connector', 'version': '4.0.0', 'private': True, 'type': 'module', 'dependencies': dependencies}).encode()
        overrides['README.md']=('''# 矩阵云电脑连接器

## 第一次使用

1. 把 ZIP **完整解压**到电脑上的普通文件夹，不要直接在压缩包里运行。
2. Windows 双击 `START-CONNECTOR.bat`；Mac 双击 `启动连接器.command`；Linux 在终端运行 `./START-CONNECTOR.sh`。
3. 连接器会自动打开矩阵云授权页。客户可自行注册并登录，点击“授权连接这台电脑”，按页面提示完成即可；不需要输入服务器地址、端口或配对码。
4. 回到工作台，在账号矩阵选择这台电脑。打开小红书并完成登录后会自动同步；内容审核通过后会自动保存草稿。

已内置运行环境和依赖，无需安装 Node 或开发工具。连接器窗口请保持运行，电脑休眠或断网后重新双击启动入口即可。

工作台可以用 Safari、Chrome、Edge 或 Firefox 打开；执行电脑需要可用的 Google Chrome 或 Microsoft Edge，连接器会在其中自动打开小红书登录窗口，客户直接在浏览器里扫码。如果系统首次显示安全提示，请确认文件来自矩阵云后正常允许运行，不要关闭系统安全保护。首次运行仍需团队成员完成自己的工作台登录和连接授权，这是设备归属确认，不能由安装包代替。

同一电脑不要同时启动多份连接器。设备被管理员撤销后，关闭窗口并重新双击入口即可重新授权。仅使用正常且获授权的平台账号，遇到验证码、异常登录或限制会自动暂停并提示人工核对。

如果授权页没有自动打开，可在窗口中复制显示的授权地址到浏览器；如果忘记设备配对，Windows 使用同目录的 `PAIR-CONNECTOR.bat`、Mac 使用 `PAIR-CONNECTOR.command`、Linux 使用 `PAIR-CONNECTOR.sh` 按提示重新配对。
''').encode()
        if candidate:
            overrides['README.md'] += '\n本包为待验候选，真实系统首次运行及账号完整流程验收待完成。\n'.encode()
        if windows:
            # The visible entry point must be zero-configuration: launch.mjs
            # opens the local onboarding page and the fixed HTTPS workbench.
            # Pairing remains a separate recovery entry point.
            launcher='@echo off\r\nsetlocal\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nset "NODE=%~dp0runtime\\node\\node.exe"\r\nif not exist "%NODE%" (echo 安装包不完整，请重新下载。& pause& exit /b 1)\r\n"%NODE%" local-connector\\launch.mjs %*\r\nif errorlevel 1 pause\r\n'
            overrides['START-CORE.bat']=launcher.encode('utf-8')
            overrides['START-CONNECTOR.bat']=launcher.encode('utf-8')
            # Keep the older Chinese entries usable too.  They are easy to
            # choose accidentally after extraction; neither should bring
            # back the old server/port prompts.  The dedicated pairing entry
            # remains an explicit recovery flow.
            overrides['启动连接器.bat']='@echo off\r\ncall "%~dp0START-CONNECTOR.bat" %*\r\n'.encode('utf-8')
            overrides['首次配对.bat']='@echo off\r\ncall "%~dp0PAIR-CONNECTOR.bat"\r\n'.encode('utf-8')
            # Node reads recovery input and passes each value as an argv item.
            # Batch never expands a device name or pairing code as cmd syntax.
            pair_launcher=launcher.replace('launch.mjs %*', 'pair.mjs')
            overrides['PAIR-CORE.bat']=pair_launcher.encode('utf-8')
            overrides['PAIR-CONNECTOR.bat']='@echo off\r\ncall "%~dp0PAIR-CORE.bat"\r\n'.encode('utf-8')
        else:
            launcher='#!/bin/bash\nset -e\ncd "$(dirname "$0")" || exit 1\nNODE="$PWD/runtime/node/bin/node"\nif [ ! -x "$NODE" ]; then echo "安装包不完整，请重新下载。"; exit 1; fi\nexec "$NODE" local-connector/launch.mjs "$@"\n'
            overrides['启动连接器.command' if macos else 'START-CONNECTOR.sh']=launcher.encode()
            overrides['PAIR-CONNECTOR.command' if macos else 'PAIR-CONNECTOR.sh']=launcher.replace('launch.mjs "$@"', 'pair.mjs').encode()
        for name,path in sorted(candidates.items()):
            rel = source+'/'+name
            info = zipfile.ZipInfo(rel)
            info.date_time = (2026, 1, 1, 0, 0, 0)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            effective_mode=0o755 if name == 'runtime/node/bin/node' or name.endswith(('.command', '.sh')) else 0o644
            info.external_attr = ((stat.S_IFREG | effective_mode) << 16)
            data = overrides.pop(name,path.read_bytes())
            archive.writestr(info, data)
            manifest.append({"path": rel, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        for name,data in overrides.items():
            rel=source+'/'+name
            info=zipfile.ZipInfo(rel)
            info.date_time=(2026,1,1,0,0,0)
            info.compress_type=zipfile.ZIP_DEFLATED
            info.create_system=3
            info.external_attr=(stat.S_IFREG | (0o755 if name.endswith(('.command', '.sh')) else 0o644)) << 16
            archive.writestr(info,data)
            manifest.append({'path':rel,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
        manifest_data = json.dumps({"format": 2, "platform": platform, "cloudUrl": cloud_url, "candidate": bool(candidate), "runtime": runtime_meta, "files": manifest}, ensure_ascii=False, indent=2).encode()
        info = zipfile.ZipInfo(f"{source}/MANIFEST.json")
        info.date_time = (2026, 1, 1, 0, 0, 0)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        archive.writestr(info, manifest_data)
    temporary_output.replace(output)
    print(f"{output} {output.stat().st_size} bytes {len(manifest)} files")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=pathlib.Path, default=ROOT / "outputs" / "connectors")
    parser.add_argument("--runtime-root", type=pathlib.Path, default=ROOT)
    parser.add_argument("--node-runtime-root", type=pathlib.Path, help="经官方校验的运行时根目录，含所选平台目录；替换基础目录的 Node")
    parser.add_argument("--cloud-url", required=True, help="客户工作台的 HTTPS 地址")
    parser.add_argument("--allow-unsigned", action="store_true", help="仅用于待验候选，允许 Mac 运行时签名未校验；正式发布不得使用")
    parser.add_argument('--platform', action='append', choices=PLATFORMS, help='只构建指定平台，可重复；默认构建 Windows x64 和两种 Mac')
    args = parser.parse_args()
    from urllib.parse import urlparse
    url=urlparse(args.cloud_url)
    if url.scheme!='https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('','/'):
        raise SystemExit('交付地址必须是无凭证的 HTTPS 站点地址')
    for platform in dict.fromkeys(args.platform or ('windows', 'mac-intel', 'mac-arm64')):
        source, filename = PLATFORMS[platform]
        build(source, args.output_dir / filename, platform, args.runtime_root, args.cloud_url.rstrip('/'), args.node_runtime_root, args.allow_unsigned)


if __name__ == "__main__":
    main()
