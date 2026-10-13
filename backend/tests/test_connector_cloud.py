import asyncio
import json
import httpx
import pytest
from connector.cloud import CloudChannel,register_cloud_connector,load_cloud_device,cloud_request
from connector.server import create_connector_app
from connector.files import atomic_json
from fastapi.testclient import TestClient

def run(coro):return asyncio.run(coro)

def test_cloud_origin_canonicalization_preserves_existing_url_contract():
    from connector.cloud import normalize_cloud_url
    assert normalize_cloud_url('https://CLOUD.example:443/')=='https://cloud.example'
    assert normalize_cloud_url('http://[::1]:80/')=='http://[::1]'
    assert normalize_cloud_url('https://cloud.example:444/')=='https://cloud.example:444'

def test_pairing_failed_response_cannot_overwrite_existing_device(tmp_path):
    old=dict(cloudUrl='https://old.example',deviceId='old',deviceToken='a'*64,workspace='old-workspace')
    atomic_json(tmp_path/'cloud-device.json',old)
    async def scenario():
        calls=[]
        def handler(request):calls.append(request);return httpx.Response(200,json=dict(deviceId='new',deviceToken='invalid',workspace='new'))
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with pytest.raises(ValueError):await register_cloud_connector(cloud_url='https://new.example',pairing_code='12345678',root=tmp_path,client=client)
        assert len(calls)==1 and json.loads(calls[0].content)['version']=='4.0.0'
        assert load_cloud_device(tmp_path)==old
        assert not list(tmp_path.glob('.cloud-device-*'))
        await client.aclose()
    run(scenario())

def test_cloud_redirect_does_not_send_device_token_to_new_origin():
    async def scenario():
        calls=[]
        def handler(request):calls.append(request);return httpx.Response(302,headers={'location':'https://evil.example'})
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler),follow_redirects=True)
        with pytest.raises(ValueError):await cloud_request(dict(cloudUrl='https://cloud.example',deviceToken='a'*64),'/api/connector/heartbeat',client=client)
        assert len(calls)==1 and calls[0].url.host=='cloud.example'
        await client.aclose()
    run(scenario())

def test_revocation_expires_lease_and_never_retries_heartbeat(tmp_path):
    async def scenario():
        calls=[]; revoked=[]
        def handler(request):calls.append(request);return httpx.Response(401,json=dict(message='revoked'))
        async def on_revoked():revoked.append(True)
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)); channel=CloudChannel(dict(cloudUrl='https://cloud.example',deviceToken='a'*64),root=tmp_path,port=1,token='b'*64,client=client,on_revoked=on_revoked)
        channel.lease(); await channel.heartbeat()
        assert len(calls)==1 and channel.revoked and channel.stopped and revoked==[True]
        assert json.loads((tmp_path/'device-lease.json').read_text())['until']==0
        await channel.close()
    run(scenario())

def test_rpc_size_limit_finishes_with_error_and_does_not_emit_end(tmp_path,monkeypatch):
    import connector.cloud as cloud
    monkeypatch.setattr(cloud,'MAX_RPC_BYTES',5)
    async def scenario():
        frames=[]
        class WS:
            async def send(self,s):frames.append(json.loads(s))
        client=httpx.AsyncClient(transport=httpx.MockTransport(lambda req:httpx.Response(200,content=b'123456')))
        channel=CloudChannel(dict(cloudUrl='https://cloud.example',deviceToken='a'*64),root=tmp_path,port=1,token='b'*64,client=client)
        await channel.run_request(WS(),dict(id='id',method='GET',path='/verify'))
        assert [f['type'] for f in frames]==['head','error'] and not channel.active
        await channel.close()
    run(scenario())

def test_factory_onboarding_has_nonce_expiry_origin_and_one_use(tmp_path):
    app=create_connector_app(tmp_path,'https://cloud.example'); runtime=app.state.connector; calls=[]
    async def pair(origin,code,device_name=None):calls.append((origin,code))
    runtime.pair=pair
    with TestClient(app,base_url='http://127.0.0.1') as client:
        assert '#connectorSetup=' in client.get('/').text
        nonce=runtime.onboarding['secret']
        assert client.post('/onboarding',headers={'Origin':'https://evil.example'},data=dict(nonce=nonce,code='12345678')).status_code==403
        assert client.post('/onboarding',headers={'Origin':'https://cloud.example'},data=dict(nonce='bad',code='12345678')).status_code==403
        assert not calls
        assert client.get('/onboarding',params=dict(nonce=nonce,code='12345678')).status_code==200
        assert client.get('/onboarding',params=dict(nonce=nonce,code='12345678')).status_code==409
        assert calls==[('https://cloud.example','12345678')]

def test_rpcs_are_bound_to_paired_cloud_studio_callback(tmp_path):
    async def scenario():
        frames=[]; requests=[]
        class WS:
            async def send(self,s):frames.append(json.loads(s))
        def handler(req):requests.append(req);return httpx.Response(200,json={})
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler));channel=CloudChannel(dict(cloudUrl='https://cloud.example',deviceToken='a'*64),root=tmp_path,port=1,token='b'*64,client=client)
        await channel.run_request(WS(),dict(type='request',id='id',method='POST',path='/studio',body=dict(runId='c9014397-9dd5-4daa-8f84-4918408414fd',taskId='c9014397-9dd5-4daa-8f84-4918408414fe',profile='local:a',apiBase='https://evil.example')))
        assert not requests and frames==[dict(type='error',id='id')]
        await channel.close()
    run(scenario())
