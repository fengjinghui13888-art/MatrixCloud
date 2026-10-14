from fastapi.testclient import TestClient
from connector.server import create_connector_app
import pytest


def test_client_control_requires_local_token_and_refuses_busy_exit(tmp_path):
    app=create_connector_app(tmp_path);runtime=app.state.connector;stops=[]
    runtime.request_shutdown=lambda:stops.append(True)
    with TestClient(app,base_url='http://127.0.0.1') as client:
        assert client.get('/client-state').status_code==401
        assert client.post('/client-stop').status_code==401
        headers={'Authorization':'Bearer '+runtime.token}
        assert client.get('/client-state',headers=headers).json()['busy'] is False
        runtime.jobs.reserve_login('sample')
        assert client.post('/client-stop',headers=headers).status_code==409 and not stops
        runtime.jobs.release_login('sample')
        assert client.post('/client-stop',headers=headers).status_code==200 and stops==[True]
        assert client.post('/accounts/new/login',headers=headers).status_code==503


def test_shutdown_gate_rejects_login_that_passed_http_middleware_earlier(tmp_path):
    # A request can have entered middleware just before client-stop closes admission.
    from connector.jobs import JobManager
    jobs=JobManager(tmp_path);jobs.closed=True
    with pytest.raises(ValueError):jobs.reserve_login('already-admitted-request')
