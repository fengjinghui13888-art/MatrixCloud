import json
import os
from pathlib import Path
import subprocess
import sys

BACKEND = Path(__file__).resolve().parents[1]


def run_settings(cwd, overrides=None):
    env = dict(os.environ, PYTHONPATH=str(BACKEND))
    for name in ("DATA_DIR", "SYNC_DATA_DIR", "MCP_SERVICE_TOKEN", "DATABASE_URL", "DATABASE_URL_FILE", "DATABASE_REQUIRED"):
        env.pop(name, None)
    env.update(overrides or {})
    return subprocess.run(
        [sys.executable, "-c", "from app.settings import Settings; import json; s=Settings.from_env(); print(json.dumps({'data':str(s.data_dir),'backend':str(s.backend_dir)}))"],
        cwd=cwd, env=env, capture_output=True, text=True,
    )


def test_default_data_directory_does_not_depend_on_launch_directory(tmp_path):
    result = run_settings(tmp_path)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "data": str(BACKEND / "data" / "work" / "grey"),
        "backend": str(BACKEND),
    }


def test_empty_optional_sync_directory_does_not_override_explicit_data(tmp_path):
    result = run_settings(tmp_path, {"DATA_DIR": str(tmp_path / "user-data"), "SYNC_DATA_DIR": ""})
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["data"] == str(tmp_path / "user-data")


def test_existing_service_token_survives_restart(tmp_path):
    from app.settings import Settings
    token = "1a" * 32
    (tmp_path / "access-token").write_text(token, encoding="utf-8")
    settings = Settings(data_dir=tmp_path)
    assert settings.get_service_token() == token
    assert settings.get_service_token() == token
    assert (tmp_path / "access-token").read_text(encoding="utf-8") == token


def test_invalid_explicit_service_token_is_rejected_without_replacement(tmp_path):
    import pytest
    from app.settings import Settings
    with pytest.raises(ValueError, match="至少 32"):
        Settings(data_dir=tmp_path, service_token="short").get_service_token()
    assert not (tmp_path / "access-token").exists()
def test_legacy_platform_owner_marker_is_used_without_env_override(tmp_path, monkeypatch):
    from app.settings import Settings
    monkeypatch.delenv('PLATFORM_ADMIN_USERNAME', raising=False)
    monkeypatch.setenv('DATA_DIR', str(tmp_path))
    monkeypatch.delenv('SYNC_DATA_DIR', raising=False)
    (tmp_path / 'platform-owner').write_text('original-platform-owner\n', encoding='utf-8')
    assert Settings.from_env().platform_admin_username == 'original-platform-owner'
