"""Explicit ACME renewal with certificate and nginx validation before reload."""
import os
from pathlib import Path
import subprocess


def renew():
    required = ('MATRIX_ACME_BIN', 'MATRIX_ACME_STATE', 'MATRIX_TLS_DATA')
    if any(not os.getenv(name) for name in required):
        raise ValueError('请设置 MATRIX_ACME_BIN、MATRIX_ACME_STATE 和 MATRIX_TLS_DATA')
    data = Path(os.environ['MATRIX_TLS_DATA']).resolve()
    log = Path(os.getenv('MATRIX_TLS_RENEW_LOG', str(data / 'renew.log')))
    with log.open('wb') as output:
        os.chmod(log, 0o600)
        subprocess.run([os.environ['MATRIX_ACME_BIN'], '--home', os.environ['MATRIX_ACME_STATE'], '--cron'], stdout=output, stderr=subprocess.STDOUT, check=True)
    subprocess.run(['openssl', 'x509', '-checkend', '86400', '-noout', '-in', str(data / 'fullchain.pem')], check=True)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    return {'ok': True, 'ingress': 'nginx'}


if __name__ == '__main__':
    print(renew())
