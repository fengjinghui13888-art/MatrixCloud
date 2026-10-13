"""Isolated adversarial checks. Never use repository data or external transports."""
import asyncio
import json
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace


import pytest
from app.gateway import Pairing, ConnectorChannel, ConnectorError, ExecutionGrants
from app.sync import WorkspaceExecution
from app.studio import Studio
from app.queues import CreationQueue
from app.store import ServiceError
from app.protocols import valid_connector_command
from connector.jobs import JobManager
from connector.files import safe_file
from connector.safety import ResultUnknown
from connector.draft import upload_with_preview

def run(coro):
    return asyncio.run(coro)

class EmptyStore:
    def list_accounts(self): return []

def test_cancelled_login_is_not_revived_by_late_start_receipt(tmp_path):
    async def scenario():
        sent, reply = asyncio.Event(), asyncio.Event()
        class Channel:
            pairing = SimpleNamespace(device_by_id=lambda *args: {'name': 'synthetic-device'})
            async def bind(self, *args): pass
            async def json(self, workspace, device, method, path):
                if path.endswith('/login'):
                    sent.set()
                    await reply.wait()
                    return {'ok': True}
                if path.endswith('/cancel'): return {'stopConfirmed': True}
                raise AssertionError(path)
        execution = WorkspaceExecution(SimpleNamespace(root=tmp_path, workspace='test', store=EmptyStore()), Channel(), ExecutionGrants(), '')
        try:
            starting = asyncio.create_task(execution.login_start(None, 'device-a'))
            await sent.wait()
            identifier = next((tmp_path/'local-logins').glob('*.json')).stem
            cancelled = await execution.login_cancel(identifier)
            assert cancelled['status'] == 'cancelled' and cancelled['stopConfirmed']
            reply.set()
            await starting
            actual = execution.login_read(identifier)
            assert actual['status'] == 'cancelled', actual
        finally: execution.browser_db.close()
    run(scenario())

def test_late_model_result_preserves_cancelled_status(tmp_path):
    from app.api import ApiRuntime, studio_dispatch
    async def scenario():
        started, reply = asyncio.Event(), asyncio.Event()
        calls=[]
        async def transport(url, headers, body):
            calls.append(url); started.set(); await reply.wait()
            return {'choices':[{'message':{'content':json.dumps({'title':'test','body':'test','tags':[],'imagePrompt':'test'})}}]}
        studio=Studio(tmp_path/'studio.sqlite')
        task=studio.create(dict(accountId='a',topic='test',persona='',style='',imageCount=1,size='1024x1024',requestId='request-1234',confirmCharge=True))['task']
        runtime=SimpleNamespace(model_transport=transport,channel=SimpleNamespace(binding=lambda *args:'synthetic-device',json=lambda *args:None),studio_workers={})
        scope=SimpleNamespace(studio=studio,workspace='synthetic')
        execution=SimpleNamespace(account=lambda _:dict(profile='local:a'))
        inputs={'settings':dict(label='mock',protocol='chat-completions',baseUrl='https://mock.example/v1',model='mock',imageModel='mock',apiKey='synthetic'), 'references':[]}
        generating=asyncio.create_task(ApiRuntime.generate(runtime,scope,task,inputs))
        await started.wait()
        request=SimpleNamespace(url=SimpleNamespace(path='/api/studio/'+task['id']+'/cancel'),path_params={'id':task['id']},method='POST')
        cancelled=await studio_dispatch(request,runtime,scope,execution,{})
        assert json.loads(cancelled.body)['status']=='blocked'
        reply.set(); await generating
        actual=studio.get(task['id'])
        assert len(calls)==1
        assert actual['status']=='blocked', actual
    run(scenario())

def test_same_request_concurrent_creation_and_claim(tmp_path):
    queue=CreationQueue(tmp_path/'creation.sqlite')
    body=dict(topic='t',sellingPoints='',audience='',style='',imageCount=1,requestId='request-1234')
    with ThreadPoolExecutor(8) as pool:
        tasks=list(pool.map(lambda _:queue.create(body),range(24)))
    assert len({t['id'] for t in tasks})==1
    def claim(_):
        try: return queue.claim(tasks[0]['id'])['status']
        except ServiceError as exc: return exc.status
    with ThreadPoolExecutor(8) as pool: results=list(pool.map(claim,range(24)))
    assert results.count('running')==1 and results.count(409)==23
    with pytest.raises(ServiceError): queue.create({**body,'topic':'changed'})


def test_cancel_stops_scheduled_generation_without_an_execution_device(tmp_path):
    from app.api import ApiRuntime, studio_dispatch
    async def scenario():
        started, stopped = asyncio.Event(), asyncio.Event()
        async def transport(*args):
            started.set()
            try: await asyncio.Event().wait()
            finally: stopped.set()
        studio = Studio(tmp_path/'studio.sqlite')
        task = studio.create(dict(accountId='a',topic='test',persona='',style='',imageCount=1,size='1024x1024',requestId='cancel-scheduled',confirmCharge=True))['task']
        scope = SimpleNamespace(studio=studio,workspace='synthetic')
        runtime = SimpleNamespace(model_transport=transport,generation_workers=set(),generation_tasks={},studio_workers={},channel=SimpleNamespace(binding=lambda *args:None))
        runtime.generate = lambda *args: ApiRuntime.generate(runtime,*args)
        inputs = {'settings':dict(label='mock',protocol='chat-completions',baseUrl='https://mock.example/v1',model='mock',imageModel='mock',apiKey='synthetic'),'references':[]}
        ApiRuntime.schedule_generation(runtime,scope,task,inputs)
        await started.wait()
        request=SimpleNamespace(url=SimpleNamespace(path='/api/studio/'+task['id']+'/cancel'),path_params={'id':task['id']},method='POST')
        await studio_dispatch(request,runtime,scope,SimpleNamespace(account=lambda _:None),{})
        await asyncio.wait_for(stopped.wait(),1)
        assert studio.get(task['id'])['status']=='blocked'
    run(scenario())

def test_cancel_waits_for_cleanup_and_blocks_late_progress(tmp_path):
    async def scenario():
        started, cleanup, release=asyncio.Event(),asyncio.Event(),asyncio.Event()
        async def execute(body,progress):
            started.set()
            try: await asyncio.Event().wait()
            finally:
                cleanup.set(); await release.wait()
                await progress(dict(status='complete',message='late'))
        jobs=JobManager(tmp_path,sync_executor=execute)
        identifier=str(uuid.uuid4())
        await jobs.submit_sync(identifier,dict(target=dict(id='a',handle='a',profile='local:a'),knownNotes=[]))
        await started.wait(); await jobs.cancel('sync',identifier); await cleanup.wait()
        assert jobs.sync_state(identifier)['status']=='stopping'
        assert not jobs.sync_state(identifier)['stopConfirmed']
        release.set(); await jobs.wait_idle()
        assert jobs.sync_state(identifier)['status']=='cancelled'
        assert jobs.sync_state(identifier)['stopConfirmed']
    run(scenario())

def test_unknown_upload_replay_and_restart_do_not_execute(tmp_path):
    async def scenario():
        calls=[]
        async def execute(body,progress):
            calls.append(body['runId']); await progress(dict(uploadAttempted=True)); raise ResultUnknown('synthetic lost receipt')
        jobs=JobManager(tmp_path,studio_executor=execute,allowed_base='https://mock.example')
        from datetime import datetime,timezone
        body=dict(runId=str(uuid.uuid4()),taskId=str(uuid.uuid4()),profile='local:a',apiBase='https://mock.example',token='x'*64,startedAt=datetime.now(timezone.utc).isoformat())
        await asyncio.gather(*[jobs.submit_studio(body) for _ in range(20)])
        await jobs.wait_idle()
        assert not jobs.studio_state(body['runId'])['retrySafe']
        restored=JobManager(tmp_path,studio_executor=execute,allowed_base='https://mock.example')
        await restored.submit_studio(body); await restored.wait_idle()
        assert len(calls)==1
    run(scenario())

def test_queue_expired_before_upload_does_not_call_executor(tmp_path):
    async def scenario():
        calls=[]
        async def execute(body,progress): calls.append(body)
        jobs=JobManager(tmp_path,studio_executor=execute,allowed_base='https://mock.example')
        body=dict(runId=str(uuid.uuid4()),taskId=str(uuid.uuid4()),profile='local:a',apiBase='https://mock.example',token='x'*64,startedAt='2000-01-01T00:00:00Z')
        await jobs.submit_studio(body); await jobs.wait_idle()
        assert not calls
        state=jobs.studio_state(body['runId'])
        assert state['status']=='blocked' and state['retrySafe']
    run(scenario())

def test_unknown_native_upload_never_falls_back():
    async def scenario():
        calls=[]
        async def native(): calls.append('native'); raise ResultUnknown('timeout')
        async def fallback(): calls.append('fallback')
        async def read(_): calls.append('read'); return {'editor':False,'imageCount':0}
        with pytest.raises(ResultUnknown): await upload_with_preview(native,fallback,read,expected=1)
        assert calls==['native']
    run(scenario())

def test_gateway_rejects_foreign_tenant_device_and_run(tmp_path):
    async def scenario():
        pairing=Pairing(tmp_path/'pairing.sqlite'); channel=ConnectorChannel(pairing)
        try:
            def device(workspace):
                pairing_code=pairing.create(workspace)
                return pairing.register(pairing_code['code'],'synthetic','win32','4.0.0')['deviceId']
            a,b,c=device('a'),device('b'),device('a')
            await channel.bind('a','local:alpha',a); await channel.bind('a','local:charlie',c)
            identifier=str(uuid.uuid4())
            channel.authorize('a',a,'POST','/sync/'+identifier,dict(target=dict(id='a',profile='local:alpha'),knownNotes=[]))
            for workspace,device_id,path in [('b',a,'/verify'),('a',b,'/verify'),('a',c,'/sync/'+identifier)]:
                with pytest.raises(ConnectorError): channel.authorize(workspace,device_id,'GET',path)
            with pytest.raises(ConnectorError):
                channel.authorize('a',c,'POST','/sync/'+identifier,dict(target=dict(id='a',profile='local:charlie'),knownNotes=[]))
        finally: pairing.close()
    run(scenario())

def test_malicious_commands_and_media_paths_are_blocked(tmp_path):
    root=tmp_path/'media'; root.mkdir(); (root/'ok.png').write_bytes(b'synthetic'); (tmp_path/'secret').write_text('synthetic')
    assert safe_file(root,'ok.png').name=='ok.png'
    for relative in ['../secret',str(tmp_path/'secret'),'..\\secret','C:\\Windows\\win.ini']:
        with pytest.raises((ValueError,FileNotFoundError)): safe_file(root,relative)
    for path in ['/eval','/accounts/../login','/accounts/%2e%2e/login','/sync/../../secret','/studio/../cancel','/sync/'+str(uuid.uuid4())+'/media/../../secret']:
        assert not valid_connector_command('POST',path,{})
