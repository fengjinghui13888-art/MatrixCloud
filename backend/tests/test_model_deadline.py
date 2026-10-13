import http.client
import socket
import threading
import time
from urllib.parse import urlsplit

import pytest

from app import models


@pytest.mark.parametrize('slow_headers', [False, True])
def test_slow_drip_socket_stops_at_total_deadline(monkeypatch, slow_headers):
    # Only a synthetic loopback HTTP fixture is contacted; no TLS/provider call.
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    stopped = threading.Event()

    def serve():
        try:
            with listener.accept()[0] as peer:
                peer.recv(4096)
                prefix = b'HTTP/1.1 200 OK\r\nContent-Length: 20\r\nConnection: close\r\n\r\n'
                if not slow_headers:
                    peer.sendall(prefix)
                stream = prefix if slow_headers else b'{"synthetic":true}  '
                for byte in stream:
                    if stopped.wait(.03):
                        break
                    peer.sendall(bytes([byte]))
        except (OSError, BrokenPipeError):
            pass

    worker = threading.Thread(target=serve, daemon=True)
    worker.start()

    class LocalFixture(http.client.HTTPConnection):
        def __init__(self, host, ip, ignored_port, timeout):
            super().__init__('127.0.0.1', port=port, timeout=timeout)

    monkeypatch.setattr(models, '_PinnedHTTPS', LocalFixture)
    monkeypatch.setattr(models, 'TEXT_TIMEOUT', .14, raising=False)
    started = time.monotonic()
    try:
        with pytest.raises(models.ModelRequestError) as error:
            models._request(urlsplit('https://synthetic.example/chat/completions'), '127.0.0.1', {}, None)
        assert error.value.code == 'TIMEOUT'
        assert time.monotonic() - started < .4
    finally:
        stopped.set()
        listener.close()
        worker.join(timeout=1)
