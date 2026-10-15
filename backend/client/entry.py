"""Frozen installer entry. The immutable launcher and initial trust key ship together."""
from pathlib import Path
import argparse
import json
import os
import shutil
import sys

# Needed for source development; PyInstaller includes client as a package.
if not getattr(sys,'frozen',False):sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from client.updates import UpdateStore,atomic_json
from client.branding import create_desktop_shortcut,brand_file


def install(bundle,target=None,*,data_root=None,port=47821,autostart=False):
    bundle=Path(bundle);config=json.loads((bundle/'client-config.json').read_text(encoding='utf-8'))
    target=Path(target or Path.home()/'.matrix-cloud-client').resolve();data=Path(data_root or Path.home()/'.matrix-cloud').resolve()
    if target==data or target.is_relative_to(data) or data.is_relative_to(target):raise ValueError('安装程序与账号数据目录必须分离')
    target.mkdir(parents=True,exist_ok=True,mode=0o700)
    settings=target/'config.json'
    if settings.exists():
        old=json.loads(settings.read_text())
        if old['publicKey']!=config['publicKey'] or old['cloudUrl']!=config['cloudUrl']:raise ValueError('已安装客户端的信任密钥或工作台地址不同，请先核对，不能静默替换')
        return settings
    store=UpdateStore(target,config['publicKey']);envelope=json.loads((bundle/'seed.json').read_text());store.stage(envelope,(bundle/'seed.zip').read_bytes(),embedded=True);store.activate(envelope['manifest']['revision'])
    executable=None
    if getattr(sys,'frozen',False):
        source_app=next((p for p in Path(sys.executable).parents if p.suffix=='.app'),None) if sys.platform=='darwin' else None
        if source_app:
            installed_app=target/'MatrixCloud.app';shutil.copytree(source_app,installed_app)
            executable=installed_app/Path(sys.executable).relative_to(source_app)
        else:
            executable=target/('MatrixCloudClient.exe' if os.name=='nt' else 'MatrixCloudClient')
            shutil.copy2(sys.executable,executable)
        executable.chmod(0o700)
    config.update(installRoot=str(target),dataRoot=str(data),port=port,updateInterval=3600,openOnStart=True)
    atomic_json(settings,config)
    if executable:
        create_desktop_shortcut(executable,settings)
        if os.name=='nt':
            if any(c in str(executable)+str(settings) for c in '%\r\n'):raise ValueError('安装路径包含不支持的启动字符')
            start=target/'启动矩阵云客户端.cmd';start.write_text('@echo off\r\nchcp 65001 >nul\r\n"'+str(executable)+'" --config "'+str(settings)+'"\r\n',encoding='utf-8')
            if autostart:
                startup=Path(os.environ['APPDATA'])/'Microsoft/Windows/Start Menu/Programs/Startup';startup.mkdir(parents=True,exist_ok=True)
                # Fixed paths, shell special characters never enter the generated launcher.
                if any(c in str(executable)+str(settings) for c in '%&|<>^\r\n'):raise ValueError('安装路径包含不支持的启动字符')
                import win32com.client
                shortcut=win32com.client.Dispatch('WScript.Shell').CreateShortCut(str(startup/'MatrixCloudClient.lnk'))
                shortcut.TargetPath=str(executable);shortcut.Arguments='--config "'+str(settings)+'" --background';shortcut.WorkingDirectory=str(target);shortcut.WindowStyle=7;shortcut.save()
        elif autostart:
            import plistlib
            agents=Path.home()/'Library/LaunchAgents';agents.mkdir(parents=True,exist_ok=True)
            with (agents/'com.matrixcloud.connector.plist').open('wb') as f:plistlib.dump(dict(Label='com.matrixcloud.connector',ProgramArguments=[str(executable),'--config',str(settings),'--background'],RunAtLoad=True,KeepAlive=False),f)
    return settings


def main():
    # Worker/supervisor reentry bypasses installation.
    if '--config' in sys.argv:
        from client.launcher import main as launch
        return launch()
    parser=argparse.ArgumentParser();parser.add_argument('--bundle',type=Path);parser.add_argument('--install-root',type=Path);parser.add_argument('--data-root',type=Path);parser.add_argument('--port',type=int,default=47821);parser.add_argument('--autostart',action='store_true');parser.add_argument('--install-only',action='store_true');args=parser.parse_args()
    bundle=args.bundle or Path(getattr(sys,'_MEIPASS',Path(__file__).resolve().parent))/'bootstrap'
    if len(sys.argv)==1 and not (Path.home()/'.matrix-cloud-client/config.json').exists():
        import tkinter as tk
        window=tk.Tk();window.title('HUAKE FUTURE · MatrixCloud');window.geometry('480x350');window.resizable(False,False)
        icon=tk.PhotoImage(file=str(brand_file('app-icon.png')));window.iconphoto(True,icon)
        display_icon=icon.subsample(8,8);tk.Label(window,image=display_icon,pady=12).pack()
        tk.Label(window,text='HUAKE FUTURE · MatrixCloud',font=('',18),pady=8).pack()
        tk.Label(window,text='安装一次，后续自动更新。\n扫码、同步和草稿任务在本机 Chrome 中执行。',pady=12).pack()
        automatic=tk.BooleanVar(value=True);tk.Checkbutton(window,text='登录电脑后自动启动客户端',variable=automatic).pack()
        accepted=[]
        def accept():accepted.append(automatic.get());window.destroy()
        tk.Button(window,text='安装并打开工作台',command=accept,width=24,pady=8).pack(pady=16)
        window.mainloop()
        if not accepted:return
        args.autostart=accepted[0]
    settings=install(bundle,args.install_root,data_root=args.data_root,port=args.port,autostart=args.autostart)
    print('矩阵云客户端已安装。首次请在浏览器工作台授权；之后更新由客户端自动完成。')
    if not args.install_only:
        from client.launcher import main as launch
        return launch(['--config',str(settings)])


if __name__=='__main__':main()
