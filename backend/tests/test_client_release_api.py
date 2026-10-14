from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from app.api import create_app
from app.settings import Settings


def test_release_endpoints_are_public_but_only_serve_fixed_release_files(tmp_path):
    releases=tmp_path/'releases';(releases/'packages').mkdir(parents=True);(releases/'packages/1.zip').write_bytes(b'package');(releases/'manifest.json').write_text('{"manifest":{}}');(releases/'private-key').write_text('secret')
    settings=Settings(data_dir=tmp_path/'data',connector_client_releases_dir=releases)
    with TestClient(create_app(settings=settings),base_url='http://127.0.0.1') as c:
        assert c.get('/api/connector/client/manifest').status_code==200
        assert c.get('/api/connector/client/packages/1.zip').content==b'package'
        assert c.get('/api/connector/client/private-key').status_code!=200
        assert c.get('/api/connector/client/packages/../private-key').status_code!=200
        assert c.post('/api/connector/client/manifest').status_code!=200


def test_production_never_serves_local_unsigned_installer(tmp_path):
    releases=tmp_path/'releases';(releases/'installers').mkdir(parents=True);(releases/'installers/windows.exe').write_bytes(b'candidate');(releases/'installers/readiness.json').write_text('{"windows.exe":{"productionReady":false}}')
    with TestClient(create_app(settings=Settings(data_dir=tmp_path/'data',environment='production',connector_client_releases_dir=releases)),base_url='http://127.0.0.1') as c:
        assert c.get('/api/connector/client/installers/windows.exe').status_code==404
