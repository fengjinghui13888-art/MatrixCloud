"""Shared brand resources and customer-only desktop entry point."""
from pathlib import Path
import sys
from urllib.parse import urlsplit


def brand_file(name):
    root=Path(getattr(sys,'_MEIPASS',Path(__file__).resolve().parent))
    return root/'brand'/name


def workbench_url(config):
    # Keep the stable launcher independent of the updatable connector package.
    try:url=urlsplit(config['cloudUrl']);port=url.port
    except (ValueError,TypeError) as error:raise ValueError('工作台地址无效') from error
    if not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('','/') or (url.scheme!='https' and not(url.scheme=='http' and url.hostname in ('localhost','127.0.0.1','::1'))):
        raise ValueError('请填写工作台源地址，不能使用后台路径')
    host=url.hostname.lower();host='['+host+']' if ':' in host else host
    suffix='' if port is None or port==({'https':443,'http':80}.get(url.scheme)) else ':'+str(port)
    return f'{url.scheme}://{host}{suffix}/'


def create_desktop_shortcut(executable,settings):
    executable=Path(executable).resolve();settings=Path(settings).resolve()
    if sys.platform=='win32':
        import win32com.client
        shell=win32com.client.Dispatch('WScript.Shell')
        desktop=Path(shell.SpecialFolders('Desktop'))
        shortcut=shell.CreateShortCut(str(desktop/'矩阵云 MatrixCloud.lnk'))
        shortcut.TargetPath=str(executable);shortcut.Arguments='--config "'+str(settings)+'"'
        shortcut.WorkingDirectory=str(executable.parent);shortcut.IconLocation=str(executable)+',0'
        shortcut.Description='HUAKE FUTURE MatrixCloud · 打开客户工作台'
        shortcut.WindowStyle=7;shortcut.save()
        return desktop/'矩阵云 MatrixCloud.lnk'
    if sys.platform=='darwin':
        app=next((p for p in executable.parents if p.suffix=='.app'),None)
        if app is None:raise ValueError('Mac 桌面入口需要原生 .app 安装包')
        link=Path.home()/'Desktop'/'MatrixCloud.app'
        if not link.exists() and not link.is_symlink():link.symlink_to(app,target_is_directory=True)
        return link
    return None
