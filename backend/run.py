"""Portable entry points. Python runs services; Node runs only the React dev server."""
import argparse
from dataclasses import replace
import importlib.metadata
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

BACKEND = Path(__file__).resolve().parent
FRONTEND = BACKEND.parent / 'frontend'


def assert_port_free(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((host, port))
        except OSError as error:
            raise RuntimeError(f'端口 {port} 已被占用，请关闭已有实例或指定其他端口。') from error


def command_for(kind, host='127.0.0.1', port=4174):
    if kind == 'server':
        return [sys.executable, '-X', 'utf8', str(BACKEND / 'run.py'), 'server', '--host', host, '--port', str(port)]
    if kind == 'frontend':
        node = shutil.which('node')
        if not node:
            raise RuntimeError('前端需要 Node.js 22.14–24，请安装后重试。')
        return [node, str(FRONTEND / 'node_modules' / 'vite' / 'bin' / 'vite.js'), '--host', host, '--port', str(port), '--strictPort']
    raise ValueError('不支持的服务类型')


def check_dependencies(frontend=False):
    if sys.version_info < (3, 13):
        raise RuntimeError('后端需要 Python 3.13 或更新版本，请使用 backend/.venv。')
    required = ('fastapi', 'uvicorn', 'httpx', 'psycopg', 'pillow', 'cryptography', 'bcrypt', 'mcp', 'playwright', 'websockets', 'requests')
    for name in required:
        try:
            importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError as error:
            raise RuntimeError('缺少依赖，请执行：python -m pip install -r backend/requirements.txt') from error
    if frontend:
        command_for('frontend')
        if not (FRONTEND / 'node_modules' / 'vite' / 'bin' / 'vite.js').is_file():
            raise RuntimeError('请先在 frontend 内执行 pnpm install --frozen-lockfile。')


def wait_ready(url, children, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if any(child.poll() is not None for child in children):
            raise RuntimeError('服务启动失败，请查看窗口中的错误。')
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        time.sleep(.2)
    raise RuntimeError('服务未在等待时间内就绪，请查看启动日志。')


def start_all(args, settings):
    # ALL is the local React development entry. Production TLS belongs to the
    # separate server command; never expose a downgraded listener publicly.
    settings = replace(settings, host='127.0.0.1', public_origin=f'http://127.0.0.1:{args.frontend_port}', tls_cert=None, tls_key=None)
    check_dependencies(frontend=True)
    assert_port_free(settings.host, settings.port)
    assert_port_free('127.0.0.1', args.frontend_port)
    # Build every command before starting children so a missing frontend fails atomically.
    commands = [(command_for('server', settings.host, settings.port), BACKEND),
                (command_for('frontend', port=args.frontend_port), FRONTEND)]
    environment = dict(os.environ)
    environment.update(PYTHONUTF8='1', BACKEND_URL=f'http://127.0.0.1:{settings.port}',
                       PUBLIC_ORIGIN=settings.public_origin, CUSTOMER_PUBLIC_ORIGIN=settings.public_origin,
                       TLS_CERT='', TLS_KEY='', DATA_DIR=str(settings.data_dir))
    children = []
    try:
        for command, cwd in commands:
            children.append(subprocess.Popen(command, cwd=cwd, env=environment))
        wait_ready(f'http://127.0.0.1:{settings.port}/api/health', children)
        wait_ready(f'http://127.0.0.1:{args.frontend_port}/', children)
        url = f'http://127.0.0.1:{args.frontend_port}/'
        print(f'工作台已启动：{url}\n关闭此窗口或按 Ctrl+C 停止前后端。', flush=True)
        if not args.no_open:
            webbrowser.open(url)
        while all(child.poll() is None for child in children):
            time.sleep(.4)
        return next((child.returncode for child in children if child.poll() is not None), 1) or 1
    except KeyboardInterrupt:
        return 0
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def main(argv=None):
    parser = argparse.ArgumentParser(description='矩阵云 Python 启动器')
    parser.add_argument('mode', choices=('all', 'server', 'connector', 'mcp', 'maintenance', 'check'), nargs='?', default='all')
    parser.add_argument('--host')
    parser.add_argument('--port', type=int)
    parser.add_argument('--frontend-port', type=int, default=5173)
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--connector-root', type=Path)
    parser.add_argument('--cloud-url')
    parser.add_argument('--workspace', default='owner')
    parser.add_argument('--legacy', action='store_true', help='Use the original three WorkBuddy MCP tools')
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args(argv)
    os.chdir(BACKEND)
    from app.settings import Settings, load_env_file
    load_env_file()
    settings = Settings.from_env()
    overrides = {key: getattr(args, key) for key in ('host', 'data_dir') if getattr(args, key) is not None}
    if args.port is not None and args.mode in ('all', 'server'):
        overrides['port'] = args.port
    if args.mode == 'all' and not os.getenv('PUBLIC_ORIGIN') and not os.getenv('CUSTOMER_PUBLIC_ORIGIN'):
        overrides['public_origin'] = f'http://127.0.0.1:{args.frontend_port}'
    settings = replace(settings, **overrides)
    check_dependencies(frontend=args.mode in ('all', 'check'))
    if args.mode == 'check':
        print(f'依赖检查通过。前端：{FRONTEND}\n后端：{BACKEND}\n数据：{settings.data_dir}')
        return 0
    if args.mode == 'all':
        return start_all(args, settings)
    if args.mode == 'server':
        import uvicorn
        from app.api import create_app
        assert_port_free(settings.host, settings.port)
        uvicorn.run(create_app(settings=settings), host=settings.host, port=settings.port,
                    proxy_headers=False, server_header=False,
                    ssl_certfile=str(settings.tls_cert) if settings.tls_cert else None,
                    ssl_keyfile=str(settings.tls_key) if settings.tls_key else None)
    elif args.mode == 'connector':
        import uvicorn
        from connector.server import create_connector_app
        port = args.port or 47821
        assert_port_free('127.0.0.1', port)
        root = (args.connector_root or settings.data_dir / 'local-connector').resolve()
        uvicorn.run(create_connector_app(root, cloud_url=args.cloud_url or os.getenv('MATRIX_CLOUD_URL') or settings.public_origin, port=port),
                    host='127.0.0.1', port=port, proxy_headers=False, server_header=False)
    elif args.mode == 'mcp':
        from app.mcp_server import run_stdio
        run_stdio(settings=settings, workspace=args.workspace, legacy=args.legacy)
    elif args.mode == 'maintenance':
        from app.maintenance import run_maintenance
        run_maintenance(settings=settings, port=args.port or 4176)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, ValueError, ImportError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
