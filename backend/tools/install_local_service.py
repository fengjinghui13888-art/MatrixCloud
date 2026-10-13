"""Explicitly start the current user's hidden Python backend supervisor."""
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


def install():
    from app.settings import Settings, load_env_file
    from run import assert_port_free, check_dependencies
    load_env_file()
    settings = Settings.from_env()
    check_dependencies()
    assert_port_free(settings.host, settings.port)
    options = {'creationflags': subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
    child = subprocess.Popen([sys.executable, '-X', 'utf8', str(BACKEND / 'tools' / 'local_supervisor.py')], cwd=BACKEND,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **options)
    for _ in range(80):
        if child.poll() is not None:
            break
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{settings.port}/api/health', timeout=1) as response:
                if response.status == 200:
                    return {'pid': child.pid, 'status': 'started', 'frontend': settings.public_origin}
        except OSError:
            pass
        time.sleep(.25)
    child.terminate()
    child.wait(timeout=8)
    raise RuntimeError('启动失败，请检查 backend/data/work/grey/service-logs/workbench-error.log')


if __name__ == '__main__':
    print(install())
