"""Manage only this project's explicitly configured local PostgreSQL cluster.

Schema creation and data migration are deliberately separate from normal startup.
"""
from pathlib import Path
import argparse
import json
import os
import subprocess
import sys

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND / 'data' / 'postgresql'


def configuration():
    path = ROOT / 'local.json'
    if not path.is_file():
        raise RuntimeError('本机 PostgreSQL 尚未配置，请按 docs/数据库与启动.md 初始化。')
    cfg = json.loads(path.read_text(encoding='utf-8'))
    for name in ('bin', 'cluster'):
        target = (ROOT / cfg[name]).resolve()
        if not target.is_relative_to(ROOT.resolve()):
            raise ValueError('PostgreSQL 路径必须位于 backend/data/postgresql 内。')
        cfg[name] = target
    if cfg.get('host') != '127.0.0.1' or type(cfg.get('port')) is not int or not 1024 <= cfg['port'] <= 65535:
        raise ValueError('本机 PostgreSQL 必须使用有效的回环端口。')
    if not (cfg['cluster'] / 'PG_VERSION').is_file():
        raise RuntimeError('PostgreSQL 数据目录尚未初始化。')
    return cfg


def control(action):
    cfg = configuration()
    executable = cfg['bin'] / ('pg_ctl.exe' if os.name == 'nt' else 'pg_ctl')
    if not executable.is_file():
        raise RuntimeError('找不到本机 PostgreSQL 运行程序。')
    command = [str(executable), '-D', str(cfg['cluster'])]
    options = dict(capture_output=True, text=True, encoding='utf-8', errors='replace',
                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    result = subprocess.run([*command, 'status'], **options)
    if action == 'status':
        return result.returncode == 0
    if action == 'start' and result.returncode != 0:
        # On Windows the detached server can inherit pipe handles. Redirect to
        # a real file so communicate() cannot wait on a long-lived child pipe.
        with (ROOT / 'control.log').open('a', encoding='utf-8') as output:
            result = subprocess.run([*command, '-l', str(ROOT / 'server.log'), '-w', '-t', '30',
                                     '-o', f'-p {cfg["port"]} -h 127.0.0.1', 'start'],
                                    stdout=output, stderr=output, stdin=subprocess.DEVNULL,
                                    creationflags=options['creationflags'], timeout=40)
    elif action == 'stop' and result.returncode == 0:
        result = subprocess.run([*command, '-m', 'fast', '-w', '-t', '30', 'stop'], **options)
    elif action == 'stop':
        return False
    if result.returncode:
        raise RuntimeError('PostgreSQL 操作失败，请查看 backend/data/postgresql/server.log。')
    return action == 'start'


def ensure_for_url(url):
    from psycopg.conninfo import conninfo_to_dict
    cfg = configuration()
    params = conninfo_to_dict(url or '')
    if params.get('host') != cfg['host'] or params.get('port') != str(cfg['port']) or params.get('dbname') != cfg['database']:
        raise ValueError('LOCAL_POSTGRES 配置与数据库连接不一致；远程数据库请设置 LOCAL_POSTGRES=false。')
    control('start')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('start', 'stop', 'status'))
    args = parser.parse_args()
    try:
        running = control(args.action)
        print('本机 PostgreSQL 已运行。' if running else '本机 PostgreSQL 已停止。')
    except (RuntimeError, ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
