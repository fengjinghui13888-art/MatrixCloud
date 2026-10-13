"""Compatibility tests use synthetic workspace data and in-process transports only."""
import importlib.util
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def api_module():
    assert importlib.util.find_spec('app.api'), 'Python API implementation is missing'
    from app.api import create_app
    return create_app


def test_original_route_registrations_have_python_handlers(tmp_path):
    from app.settings import Settings
    app = api_module()(Settings(data_dir=tmp_path, service_token='s' * 64))
    paths = {(method, route.path.replace('{', ':').replace('}', ''))
             for route in app.routes for method in getattr(route, 'methods', [])}
    contracts = json.loads((Path(__file__).parents[1] / 'docs/migration/original-api-contracts.json').read_text(encoding='utf-8'))
    missing = [(r['method'], r['path']) for r in contracts if (r['method'], r['path']) not in paths]
    assert missing == []


def test_anonymous_request_and_cross_origin_write_are_denied(tmp_path):
    from app.settings import Settings
    with TestClient(api_module()(Settings(data_dir=tmp_path, service_token='s' * 64, public_origin='http://localhost')), base_url='http://localhost') as client:
        assert client.get('/api/accounts').status_code == 401
        setup = client.post('/api/auth/setup', json={'username': 'owner', 'password': 'a-good-password-123'}, headers={'Origin': 'http://localhost'})
        assert setup.status_code == 201, setup.text
        response = client.post('/api/creation-tasks', json={}, headers={'Origin': 'https://other.example'})
        assert response.status_code == 403


def test_pairing_code_single_use_and_workspace_isolation(tmp_path):
    assert importlib.util.find_spec('app.gateway'), 'Python gateway is missing'
    from app.gateway import Pairing, ConnectorError
    pairing = Pairing(tmp_path / 'pairing.sqlite')
    issued = pairing.create('owner')
    device = pairing.register(issued['code'], 'Synthetic PC', 'win32', '4.0.0', 'local')
    assert pairing.authenticate(device['deviceToken'])['workspace'] == 'owner'
    with pytest.raises(ConnectorError):
        pairing.register(issued['code'], 'Other PC', 'win32', '4.0.0', 'local')
    with pytest.raises(ConnectorError):
        pairing.revoke(device['deviceId'], 'other-workspace')
    pairing.revoke(device['deviceId'], 'owner')
    with pytest.raises(ConnectorError):
        pairing.authenticate(device['deviceToken'])


@pytest.mark.asyncio
async def test_device_choice_counts_offline_devices(tmp_path):
    assert importlib.util.find_spec('app.gateway'), 'Python gateway is missing'
    from app.gateway import Pairing, ConnectorChannel, ConnectorError
    pairing = Pairing(tmp_path / 'pairing.sqlite')
    for name in ['Windows', 'Mac']:
        issued = pairing.create('owner')
        pairing.register(issued['code'], name, 'win32', '4.0.0')
    channel = ConnectorChannel(pairing)
    with pytest.raises(ConnectorError, match='选择'):
        await channel.browser_device('owner')


def test_execution_grants_cannot_read_other_tasks():
    assert importlib.util.find_spec('app.gateway'), 'Python gateway is missing'
    from app.gateway import ExecutionGrants
    grants = ExecutionGrants()
    token = grants.issue('workspace-a', task_id='task-a', account_id='account-a', profile='local:synthetic')
    assert grants.allowed(token, 'GET', '/api/studio/task-a')
    assert not grants.allowed(token, 'GET', '/api/studio/task-b')
    assert not grants.allowed(token, 'POST', '/api/import')


def test_postgres_auth_login_setup_and_register_keep_role_workspace(tmp_path):
    from types import SimpleNamespace
    from app.settings import Settings
    class Auth:
        def same_origin(self, *args): return True
        def active(self, workspace): return True
        def authenticate(self, *args): return dict(username='synthetic', role='admin', workspace='owner', token='a' * 64)
        def setup(self, *args): return self.authenticate()
        def register(self, *args): return self.authenticate()
    services = SimpleNamespace(auth=Auth(), db=object(), for_workspace=lambda workspace: SimpleNamespace(workspace=workspace))
    app = api_module()(Settings(data_dir=tmp_path, service_token='s' * 64), services)
    with TestClient(app, base_url='http://localhost') as client:
        for action in ('login', 'setup', 'register'):
            response = client.post('/api/auth/' + action, json=dict(username='synthetic', password='synthetic-password-123'))
            assert response.status_code == (200 if action == 'login' else 201), response.text
            assert response.json() == dict(username='synthetic', role='admin', workspace='owner')


def test_browser_pairing_requires_cookie_and_origin_even_with_service_token(tmp_path):
    from app.settings import Settings
    app = api_module()(Settings(data_dir=tmp_path, service_token='s' * 64, public_origin='http://localhost'))
    with TestClient(app, base_url='http://localhost') as client:
        headers = {'Authorization': 'Bearer ' + 's' * 64}
        assert client.get('/api/connector/capabilities', headers=headers).status_code == 401
        assert client.post('/api/auth/setup', json=dict(username='synthetic', password='synthetic-password-123'), headers={'Origin': 'http://localhost'}).status_code == 201
        assert client.post('/api/connector/pairings', json={}, headers=headers).status_code == 403
        paired = client.post('/api/connector/pairings', json={}, headers=headers | {'Origin': 'http://localhost'})
        assert paired.status_code == 201, paired.text
