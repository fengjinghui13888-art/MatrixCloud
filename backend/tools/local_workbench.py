"""Manually launched background workbench, with restart and instance reuse."""
from pathlib import Path
import os
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
RUNTIME = BACKEND / 'data' / 'local-workbench'
URL = 'http://127.0.0.1:5173/'


def healthy(url):
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return response.status == 200
    except OSError:
        return False


def commands():
    from run import command_for
    frontend = command_for('frontend', port=5173)
    frontend.insert(2, 'preview')
    return [command_for('server', port=4174), frontend]


def serve():
    from app.settings import load_env_file
    from run import frontend_environment
    load_env_file()
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with socket.socket() as guard:
        if os.name == 'nt':
            guard.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        guard.bind(('127.0.0.1', 4179))
        guard.listen(1)
        (RUNTIME / 'stop').unlink(missing_ok=True)
        env = dict(os.environ, PYTHONUTF8='1', HOST='127.0.0.1', PORT='4174',
                   PUBLIC_ORIGIN=URL.rstrip('/'), CUSTOMER_PUBLIC_ORIGIN=URL.rstrip('/'), TLS_CERT='', TLS_KEY='')
        environments = [env, frontend_environment(env, 'http://127.0.0.1:4174')]
        children = [None, None]
        retry_at = [0., 0.]
        with (RUNTIME / 'services.log').open('ab', buffering=0) as log:
            try:
                while not (RUNTIME / 'stop').exists():
                    for index, command in enumerate(commands()):
                        child = children[index]
                        if (child is None or child.poll() is not None) and time.monotonic() >= retry_at[index]:
                            children[index] = subprocess.Popen(command,
                                cwd=BACKEND if index == 0 else BACKEND.parent / 'frontend',
                                env=environments[index], stdin=subprocess.DEVNULL, stdout=log, stderr=log)
                            retry_at[index] = time.monotonic() + 5
                    time.sleep(.5)
            finally:
                for child in children:
                    if child and child.poll() is None:
                        child.terminate()
                for child in children:
                    if child:
                        try:
                            child.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            child.kill()
                            child.wait()
                (RUNTIME / 'stop').unlink(missing_ok=True)


def start(open_browser=True):
    from run import assert_port_free, check_dependencies
    from app.settings import Settings, load_env_file
    load_env_file()
    if Settings.from_env().port != 4174:
        raise RuntimeError('本地固定入口要求后端 PORT=4174，请检查 backend/.env。')
    check_dependencies(frontend=True)
    if not (BACKEND.parent / 'frontend' / 'dist' / 'index.html').is_file():
        raise RuntimeError('缺少前端构建，请先在 frontend 执行 npm run build。')
    if not (healthy(URL + 'api/health') and healthy(URL)):
        with socket.socket() as probe:
            managed = probe.connect_ex(('127.0.0.1', 4179)) == 0
        if not managed:
            for port in (4174, 5173):
                assert_port_free('127.0.0.1', port)
            RUNTIME.mkdir(parents=True, exist_ok=True)
            options = {'creationflags': subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
            with (RUNTIME / 'supervisor.log').open('ab') as log:
                subprocess.Popen([sys.executable, '-X', 'utf8', str(Path(__file__).resolve()), '--serve'],
                    cwd=BACKEND, stdin=subprocess.DEVNULL, stdout=log, stderr=log, **options)
        for _ in range(90):
            if healthy(URL + 'api/health') and healthy(URL):
                break
            time.sleep(.5)
        else:
            raise RuntimeError('服务未就绪，请查看 backend/data/local-workbench 下的日志。')
    if open_browser:
        webbrowser.open(URL)
    print('矩阵云已就绪：' + URL + '\n服务在后台运行，关闭启动窗口不会停止。连接器请单独打开桌面客户端。')


if __name__ == '__main__':
    try:
        if '--serve' in sys.argv:
            serve()
        elif '--stop' in sys.argv:
            RUNTIME.mkdir(parents=True, exist_ok=True)
            (RUNTIME / 'stop').touch()
            print('已请求停止本入口启动的前后端，数据库和连接器保留运行。')
        else:
            start(open_browser='--no-open' not in sys.argv)
    except (RuntimeError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
