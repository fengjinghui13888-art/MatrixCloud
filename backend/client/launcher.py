"""Stable supervisor. Code updates never replace data or interrupt browser jobs."""
from pathlib import Path
import argparse
import json
import os
import signal
import subprocess
import sys
import time
import webbrowser
import httpx
from .updates import UpdateStore,fetch_update,atomic_json


def switch_when_idle(busy,stop,start):
    if busy:return False
    stop();start();return True


def worker(config,version):
    root=Path(config['installRoot']);store=UpdateStore(root,config['publicKey']);path=store.validate_installed(version)
    sys.path.insert(0,str(path))
    from connector.server import create_connector_app
    import uvicorn
    app=create_connector_app(Path(config['dataRoot']),config['cloudUrl'],config['port'])
    app.state.connector.release_revision=version
    server=uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=config['port'],log_level='warning',access_log=False))
    app.state.connector.request_shutdown=lambda:setattr(server,'should_exit',True)
    server.run()


class Supervisor:
    def __init__(self,config,config_file):
        self.config=config;self.file=Path(config_file).resolve();self.root=Path(config['installRoot']);self.store=UpdateStore(self.root,config['publicKey']);self.child=None;self.log=None
        self.client=httpx.Client(trust_env=False,follow_redirects=False,timeout=10)
        self.pending=self.store.state().get('pending');self.stopping=False;self.message='正在启动';self.failures=0
    def api(self,path,method='GET'):
        token=(Path(self.config['dataRoot'])/'connector-token').read_text().strip()
        r=self.client.request(method,f'http://127.0.0.1:{self.config["port"]}'+path,headers={'Authorization':'Bearer '+token});r.raise_for_status();return r.json()
    def launch(self,revision):
        self.store.validate_installed(revision)
        command=([sys.executable] if getattr(sys,'frozen',False) else [sys.executable,'-m','client.launcher'])+['--config',str(self.file),'--worker',str(revision)]
        env=dict(os.environ);env['PYTHONPATH']=str(Path(__file__).resolve().parents[1])
        self.root.mkdir(parents=True,exist_ok=True);self.log=(self.root/'client.log').open('ab')
        options={'creationflags':subprocess.CREATE_NO_WINDOW} if os.name=='nt' else {'start_new_session':True}
        self.child=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=self.log,stderr=self.log,env=env,**options)
        deadline=time.monotonic()+35
        while time.monotonic()<deadline:
            if self.child.poll() is not None:break
            try:
                state=self.api('/client-state')
                if state['revision']==revision:
                    self.store.confirm(revision);self.message=f'连接器版本 {revision} 已运行';return
            except (OSError,ValueError,httpx.HTTPError):pass
            time.sleep(.25)
        raise RuntimeError('客户端新版本未通过启动检查')
    def stop_worker(self):
        if not self.child or self.child.poll() is not None:return
        self.api('/client-stop','POST')
        self.child.wait(timeout=15)
        if self.log:self.log.close();self.log=None
    def check(self):
        try:
            version=fetch_update(self.store,self.config['cloudUrl'],self.client)
            if version:self.pending=version;self.message=f'版本 {version} 已下载，等待任务结束'
        except Exception as exc:self.message='更新检查未完成，继续使用已安装版本：'+type(exc).__name__
        if self.pending is None:return
        try:state=self.api('/client-state')
        except (OSError,ValueError,httpx.HTTPError):
            self.message='暂时无法确认任务状态，更新稍后重试';return
        if state['busy']:return
        candidate=self.pending
        try:self.stop_worker()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code==409:self.message='有新任务开始，更新等待任务结束';return
            self.message='暂时无法安全退出，更新稍后重试';return
        except (OSError,httpx.HTTPError,subprocess.TimeoutExpired):
            self.message='尚未确认退出，更新稍后重试';return
        self.store.activate(candidate)
        try:self.launch(candidate)
        except Exception:
            # A failed startup can exit by itself; stop only our candidate process.
            if self.child and self.child.poll() is None:self.child.terminate();self.child.wait(timeout=10)
            self.store.rollback(candidate);previous=self.store.state()['current']
            if previous is None:raise
            self.launch(previous);self.message='新版本启动失败，已回退上一个可用版本'
        finally:self.pending=None
    def run(self,once=False):
        next_check=0
        try:
            current=self.store.state()['current']
            try:self.launch(current)
            except Exception:
                if self.child and self.child.poll() is None:self.child.terminate();self.child.wait(timeout=10)
                previous=self.store.state()['lastGood']
                if previous is None or previous==current:raise
                self.store.rollback(current);self.launch(previous);self.message='未确认版本启动失败，已恢复上一个可用版本'
            if self.config.get('openOnStart',True):webbrowser.open(f'http://127.0.0.1:{self.config["port"]}/')
            while True:
                if self.stopping:
                    try:
                        self.stop_worker()
                        break
                    except (OSError,ValueError,httpx.HTTPError,subprocess.TimeoutExpired):
                        if self.child.poll() is not None:break
                    self.message='等待当前浏览器任务结束后退出';time.sleep(1);continue
                if self.child.poll() is not None:
                    self.failures+=1
                    if self.failures>3:raise RuntimeError('连接器连续异常退出，请查看客户端日志')
                    time.sleep(2);self.launch(self.store.state()['current'])
                if time.monotonic()>=next_check:
                    self.check();next_check=time.monotonic()+self.config.get('updateInterval',3600)
                    atomic_json(self.root/'status.json',dict(message=self.message,revision=self.store.state()['current'],pending=self.pending,checkedAt=int(time.time())))
                    if once:return
                time.sleep(1)
        finally:
            # Refuse exit while a browser task is active; never force-close Chrome.
            if self.child and self.child.poll() is None:
                try:self.stop_worker()
                except (OSError,ValueError,httpx.HTTPError,subprocess.TimeoutExpired):pass
            self.client.close()


def main(argv=None):
    parser=argparse.ArgumentParser();parser.add_argument('--config',type=Path,required=True);parser.add_argument('--worker',type=int);parser.add_argument('--once',action='store_true');parser.add_argument('--background',action='store_true');args=parser.parse_args(argv)
    config=json.loads(args.config.read_text(encoding='utf-8'))
    if args.background:config['openOnStart']=False
    if args.worker:return worker(config,args.worker)
    # OS-backed exclusive lock prevents two supervisors sharing an install root.
    root=Path(config['installRoot']);root.mkdir(parents=True,exist_ok=True)
    with (root/'client.lock').open('a+b') as lock:
        if os.name=='nt':
            import msvcrt
            lock.seek(0);lock.write(b'0');lock.flush();lock.seek(0)
            try:msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
            except OSError:
                with httpx.Client(trust_env=False,timeout=3) as client:
                    token=(Path(config['dataRoot'])/'connector-token').read_text().strip()
                    client.get(f'http://127.0.0.1:{config["port"]}/client-state',headers={'Authorization':'Bearer '+token}).raise_for_status()
                if not args.background:webbrowser.open(f'http://127.0.0.1:{config["port"]}/')
                return
        else:
            import fcntl
            try:fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:
                if not args.background:webbrowser.open(f'http://127.0.0.1:{config["port"]}/')
                return
        supervisor=Supervisor(config,args.config)
        def stop(*_):supervisor.stopping=True
        signal.signal(signal.SIGINT,stop);signal.signal(signal.SIGTERM,stop)
        return supervisor.run(args.once)


if __name__=='__main__':main()
