"""Native-only frozen bootstrap builder. Mac binaries must be built on a Mac."""
from pathlib import Path
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys

BACKEND=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BACKEND))
from client.updates import verify_manifest,atomic_json
from connector.cloud import normalize_cloud_url


def build(releases,output,cloud_url,public_key,*,codesign_identity=None,browser_source=None):
    if codesign_identity and sys.platform!='darwin':raise ValueError('Apple 代码签名参数只能在 Mac 使用')
    output=Path(output).resolve();output.mkdir(parents=True,exist_ok=True)
    releases=Path(releases);envelope=json.loads((releases/'manifest.json').read_text());m=verify_manifest(envelope,public_key)
    bootstrap=output/'bootstrap';bootstrap.mkdir(exist_ok=True)
    atomic_json(bootstrap/'client-config.json',dict(cloudUrl=normalize_cloud_url(cloud_url),publicKey=public_key))
    atomic_json(bootstrap/'seed.json',envelope);(bootstrap/'seed.zip').write_bytes((releases/'packages'/f'{m["revision"]}.zip').read_bytes())
    browsers=output/'browsers'
    from connector.execution_browser import packaged_browser
    if browser_source:
        source=Path(browser_source).resolve()
        if not packaged_browser(source):raise ValueError('指定的执行浏览器目录不完整或平台不匹配')
        for folder in source.glob('chromium-*'):
            if folder.is_dir():shutil.copytree(folder,browsers/folder.name,dirs_exist_ok=True)
    else:
        subprocess.run([sys.executable,'-m','playwright','install','chromium','--no-shell'],check=True,env=dict(os.environ,PLAYWRIGHT_BROWSERS_PATH=str(browsers)))
    if not packaged_browser(browsers):raise ValueError('客户端执行浏览器未就绪，停止生成不完整安装包')
    command=[sys.executable,'-m','PyInstaller','--onefile','--name','MatrixCloudClient','--distpath',str(output/'dist'),'--workpath',str(output/'build'),'--specpath',str(output),'--add-data',str(bootstrap)+':bootstrap','--paths',str(BACKEND),'--hidden-import','connector.server','--hidden-import','connector.__main__','--hidden-import','playwright.async_api','--hidden-import','tkinter','--collect-submodules','uvicorn','--collect-all','playwright','--collect-all','PIL']
    brand=BACKEND/'client'/'brand'
    command+=['--add-data',str(browsers)+':browsers','--hidden-import','connector.execution_browser']
    command+=['--clean','--hidden-import','client.branding']
    command+=['--add-data',str(brand)+':brand','--icon',str(brand/('matrixcloud.icns' if sys.platform=='darwin' else 'matrixcloud.ico'))]
    if sys.platform=='win32':command+=['--hide-console','hide-early','--hidden-import','win32com.client']
    elif sys.platform=='darwin':
        command+=['--windowed','--target-architecture',platform.machine(),'--osx-bundle-identifier','com.matrixcloud.connector']
        if codesign_identity:command+=['--codesign-identity',codesign_identity]
    command.append(str(BACKEND/'client/entry.py'));subprocess.run(command,check=True,cwd=BACKEND)
    return dict(output=str(output/'dist'),platform=sys.platform,architecture=platform.machine(),revision=m['revision'],includesExecutionBrowser=True,nativeCodeSigned=bool(codesign_identity),notarized=False,productionReady=False)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--releases',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--cloud-url',required=True);parser.add_argument('--public-key',required=True);parser.add_argument('--codesign-identity');parser.add_argument('--browser-source',type=Path);args=parser.parse_args();print(json.dumps(build(args.releases,args.output,args.cloud_url,args.public_key,codesign_identity=args.codesign_identity,browser_source=args.browser_source),ensure_ascii=False))
