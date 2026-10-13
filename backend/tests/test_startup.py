import importlib.util
from pathlib import Path
import socket
import sys

import pytest


def runner():
    spec = importlib.util.spec_from_file_location('matrix_runner', Path(__file__).parents[1] / 'run.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_commands_are_anchored_to_packages_not_current_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    module = runner()
    command = module.command_for('server', host='127.0.0.1', port=42111)
    assert command[0] == sys.executable
    assert command[1:4] == ['-X', 'utf8', str(module.BACKEND / 'run.py')]
    assert command[4:] == ['server', '--host', '127.0.0.1', '--port', '42111']
    assert module.FRONTEND == module.BACKEND.parent / 'frontend'


def test_frontend_command_uses_only_frontend_vite(monkeypatch):
    module = runner()
    monkeypatch.setattr(module.shutil, 'which', lambda name: 'C:/runtime/node.exe')
    command = module.command_for('frontend', port=5173)
    assert command[1] == str(module.FRONTEND / 'node_modules' / 'vite' / 'bin' / 'vite.js')
    assert command[-1] == '--strictPort'


def test_occupied_port_fails_before_starting_any_child():
    module = runner()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        with pytest.raises(RuntimeError, match='已被占用'):
            module.assert_port_free('127.0.0.1', listener.getsockname()[1])


def test_unsupported_command_is_rejected():
    with pytest.raises(ValueError):
        runner().command_for('unknown')


def test_all_uses_local_http_children_when_old_tls_environment_exists(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from app.settings import Settings
    module = runner()
    monkeypatch.setenv('TLS_CERT', str(tmp_path / 'old.pem'))
    monkeypatch.setenv('TLS_KEY', str(tmp_path / 'old.key'))
    monkeypatch.setenv('CUSTOMER_PUBLIC_ORIGIN', 'https://old-production.example')
    monkeypatch.setattr(module, 'check_dependencies', lambda **_: None)
    monkeypatch.setattr(module, 'assert_port_free', lambda *_: None)
    monkeypatch.setattr(module, 'command_for', lambda kind, *_, **__: [kind])
    calls = []
    class Child:
        returncode = 0
        def poll(self): return None
        def terminate(self): pass
        def wait(self, **_): pass
    def launch(command, **kwargs):
        calls.append(kwargs)
        return Child()
    monkeypatch.setattr(module.subprocess, 'Popen', launch)
    monkeypatch.setattr(module, 'wait_ready', lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    settings = Settings(data_dir=tmp_path, tls_cert=tmp_path / 'old.pem', tls_key=tmp_path / 'old.key')
    assert module.start_all(SimpleNamespace(frontend_port=5173, no_open=True), settings) == 0
    assert calls[0]['env']['TLS_CERT'] == '' and calls[0]['env']['TLS_KEY'] == ''
    assert calls[0]['env']['CUSTOMER_PUBLIC_ORIGIN'] == 'http://127.0.0.1:5173'
