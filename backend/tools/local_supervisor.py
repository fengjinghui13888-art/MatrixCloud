"""Foreground backend supervisor. Invoke explicitly or through install_local_service."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


def supervise():
    from app.settings import Settings, load_env_file
    load_env_file()
    logs = Settings.from_env().data_dir / 'service-logs'
    logs.mkdir(parents=True, exist_ok=True)
    (logs / 'supervisor.pid').write_text(str(os.getpid()), encoding='ascii')
    stopping = False
    child = None
    def stop(*_):
        nonlocal stopping
        stopping = True
        if child and child.poll() is None:
            child.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        with (logs / 'workbench.log').open('ab') as output, (logs / 'workbench-error.log').open('ab') as error:
            while not stopping:
                child = subprocess.Popen([sys.executable, '-X', 'utf8', str(BACKEND / 'run.py'), 'server'], cwd=BACKEND, stdin=subprocess.DEVNULL, stdout=output, stderr=error)
                child.wait()
                for _ in range(20):
                    if stopping:
                        break
                    time.sleep(.1)
    finally:
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        (logs / 'supervisor.pid').unlink(missing_ok=True)


if __name__ == '__main__':
    supervise()
