import pytest
from tools import local_workbench as runtime


def test_existing_healthy_services_reuse_without_spawning(monkeypatch):
    from run import check_dependencies
    monkeypatch.setattr('run.check_dependencies', lambda **kw: None)
    monkeypatch.setattr(runtime, 'healthy', lambda url: True)
    monkeypatch.setattr(runtime.subprocess, 'Popen', lambda *a, **kw: pytest.fail('must reuse'))
    monkeypatch.setattr(runtime.webbrowser, 'open', lambda url: None)
    runtime.start()


def test_unmanaged_occupied_port_never_starts_or_kills_process(monkeypatch):
    monkeypatch.setattr('run.check_dependencies', lambda **kw: None)
    monkeypatch.setattr(runtime, 'healthy', lambda url: False)
    class Probe:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def connect_ex(self, address): return 1
    monkeypatch.setattr(runtime.socket, 'socket', Probe)
    def occupied(*args):
        raise RuntimeError('port occupied')
    monkeypatch.setattr('run.assert_port_free', occupied)
    monkeypatch.setattr(runtime.subprocess, 'Popen', lambda *a, **kw: pytest.fail('must not spawn'))
    with pytest.raises(RuntimeError, match='port occupied'):
        runtime.start(False)
