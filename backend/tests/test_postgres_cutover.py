import pytest

from app.settings import Settings
from app.services import Services


def test_required_postgres_cannot_silently_use_sqlite(monkeypatch):
    monkeypatch.delenv('DATABASE_URL', raising=False)
    monkeypatch.delenv('DATABASE_URL_FILE', raising=False)
    monkeypatch.setenv('DATABASE_REQUIRED', 'true')
    with pytest.raises(ValueError, match='PostgreSQL'):
        Settings.from_env()


def test_migrated_directory_cannot_be_reopened_as_sqlite(tmp_path):
    (tmp_path / 'postgres-active').write_text('{}')
    with pytest.raises(ValueError, match='PostgreSQL'):
        Services(Settings(data_dir=tmp_path))
    assert not list(tmp_path.glob('*.sqlite'))


def test_frontend_process_does_not_inherit_backend_secrets(monkeypatch):
    import run
    env = {'PATH': '/tools', 'SYSTEMROOT': 'C:/Windows', 'TEMP': '/temp',
           'DATABASE_URL': 'postgresql://app:synthetic@localhost/matrix',
           'DATABASE_URL_FILE': '/private/db', 'MCP_SERVICE_TOKEN': 'synthetic',
           'OPENAI_API_KEY': 'synthetic', 'UNRELATED_PRIVATE_KEY': 'synthetic',
           'PUBLIC_ORIGIN': 'http://127.0.0.1:5173'}
    result = run.frontend_environment(env, 'http://127.0.0.1:4174')
    assert result['PATH'] == '/tools'
    assert result['BACKEND_URL'] == 'http://127.0.0.1:4174'
    assert not any(key in result for key in ('DATABASE_URL', 'DATABASE_URL_FILE', 'MCP_SERVICE_TOKEN', 'OPENAI_API_KEY', 'UNRELATED_PRIVATE_KEY'))


def test_local_manager_rejects_a_different_database_before_start(monkeypatch):
    from tools import local_postgres
    monkeypatch.setattr(local_postgres, 'configuration', lambda: dict(host='127.0.0.1', port=5433, database='matrix'))
    def unexpected_start(_):
        pytest.fail('Must not start the local cluster for a different target')
    monkeypatch.setattr(local_postgres, 'control', unexpected_start)
    for url in ('postgresql://app@remote.example:5433/matrix', 'postgresql://app@127.0.0.1:5433/another'):
        with pytest.raises(ValueError, match='不一致'):
            local_postgres.ensure_for_url(url)
