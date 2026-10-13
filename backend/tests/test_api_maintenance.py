import hashlib
import base64
import importlib.util
import pytest


def test_maintenance_pkce_and_refresh_replay_are_rejected(tmp_path):
    assert importlib.util.find_spec('app.maintenance'), 'Maintenance Python implementation missing'
    from app.maintenance import MaintenanceAuth, password_hash
    resource = 'https://maintenance.example/maintenance/mcp'
    auth = MaintenanceAuth(dict(stateRoot=str(tmp_path), resource=resource, adminHash=password_hash('synthetic-password-123'), clients=[dict(client_id='test', redirect_uris=['http://127.0.0.1/callback'])]))
    verifier = 'a' * 43
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    pending = auth.begin(dict(client_id='test', redirect_uri='http://127.0.0.1:5100/callback', resource=resource, code_challenge=challenge, code_challenge_method='S256', scope='maintenance:read'))
    redirect = auth.consent(pending['id'], 'synthetic-password-123')
    from urllib.parse import urlsplit, parse_qs
    code = parse_qs(urlsplit(redirect).query)['code'][0]
    with pytest.raises(ValueError):
        auth.exchange(dict(grant_type='authorization_code', client_id='test', code=code, code_verifier='wrong', redirect_uri=pending['redirectUri'], resource=resource))
    tokens = auth.exchange(dict(grant_type='authorization_code', client_id='test', code=code, code_verifier=verifier, redirect_uri=pending['redirectUri'], resource=resource))
    refresh = dict(grant_type='refresh_token', client_id='test', refresh_token=tokens['refresh_token'], resource=resource)
    auth.exchange(refresh)
    with pytest.raises(ValueError):
        auth.exchange(refresh)


def test_maintenance_source_protects_data_and_symlinks(tmp_path):
    assert importlib.util.find_spec('app.maintenance'), 'Maintenance Python implementation missing'
    from app.maintenance import source_path
    (tmp_path / 'backend').mkdir()
    with pytest.raises(ValueError):
        source_path(tmp_path, 'backend/data/secret.json')
    with pytest.raises(ValueError):
        source_path(tmp_path, 'backend/.env')
    assert source_path(tmp_path, 'backend/app/api.py') == tmp_path / 'backend/app/api.py'


@pytest.mark.asyncio
async def test_separated_publication_is_blocked_before_runner(tmp_path):
    assert importlib.util.find_spec('app.maintenance'), 'Maintenance Python implementation missing'
    from app.maintenance import MaintenanceService
    repo, state = tmp_path / 'repo', tmp_path / 'state'
    repo.mkdir()
    service = MaintenanceService(dict(repoRoot=str(repo), stateRoot=str(state)))
    with pytest.raises(ValueError, match='双容器'):
        await service.prepare_release('synthetic')


def test_oauth_http_and_scope_filtered_native_mcp(tmp_path):
    import json
    from fastapi.testclient import TestClient
    from app.api import create_app
    from app.settings import Settings
    from app.maintenance import password_hash
    repo, state = tmp_path / 'repo', tmp_path / 'state'
    repo.mkdir()
    config = tmp_path / 'maintenance.json'
    resource = 'https://maintenance.example/maintenance/mcp'
    config.write_text(json.dumps(dict(repoRoot=str(repo), stateRoot=str(state), resource=resource, adminHash=password_hash('synthetic-password-123'), clients=[dict(client_id='test', redirect_uris=['http://127.0.0.1/callback'])])), encoding='utf-8')
    app = create_app(Settings(data_dir=tmp_path / 'data', service_token='s' * 64, maintenance_config=config))
    access = app.state.maintenance_auth.issue('test', ['maintenance:read'], 'family-one')['access_token']
    with TestClient(app, base_url='https://maintenance.example') as client:
        metadata = client.get('/.well-known/oauth-authorization-server')
        assert metadata.status_code == 200
        assert metadata.json()['code_challenge_methods_supported'] == ['S256']
        assert client.post('/maintenance/mcp', json={}).status_code == 401
        headers = {'Authorization': 'Bearer ' + access, 'Accept': 'application/json, text/event-stream'}
        listing = client.post('/maintenance/mcp', json={'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}, headers=headers)
        assert listing.status_code == 200, listing.text
        names = {tool['name'] for tool in listing.json()['result']['tools']}
        assert 'source_read' in names and 'change_apply' not in names and 'release_deploy' not in names
        assert client.get('/maintenance/mcp', headers=headers).status_code == 405
        app.state.maintenance_auth.revoke('test', access)
        assert client.post('/maintenance/mcp', json={}, headers=headers).status_code == 401
