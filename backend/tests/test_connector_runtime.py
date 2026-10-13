import asyncio
import json
import time
from pathlib import Path
import pytest
from connector.safety import ExecutionGuard, ResultUnknown, ActionPacer
from connector.jobs import JobManager
from connector.cloud import normalize_cloud_url, resolve_cloud_target, CloudChannel, register_cloud_connector
from connector.watch import EventOutbox
from connector.browser import verify_session_identity, verify_persisted_draft

def run(coro): return asyncio.run(coro)

def test_cloud_origin_change_does_not_reuse_credentials():
    device=dict(cloudUrl='https://old.example', deviceToken='a'*64)
    assert resolve_cloud_target(device,'https://new.example')['requiresPairing']
    assert resolve_cloud_target(device,'https://new.example')['device'] is None
    for url in ['http://evil.example','https://a.example/path','https://user:secret@a.example','https://a.example/?x=1']:
        with pytest.raises(ValueError): normalize_cloud_url(url)

def test_safety_requires_manual_confirmation_even_after_cooldown(tmp_path):
    guard=ExecutionGuard(tmp_path,'local:a',now=lambda:1000)
    guard.halt('restricted','2')
    with pytest.raises(ValueError): guard.check()
    with pytest.raises(ValueError): guard.resume(True)
    with pytest.raises(ValueError): guard.resume(False)
    assert ExecutionGuard(tmp_path,'local:a',now=lambda:5000).status()['state']=='cooldown'
    ExecutionGuard(tmp_path,'local:a',now=lambda:5000).resume(True)
    assert guard.status()['state']=='normal'

def test_lease_epoch_and_expiry_fail_closed(tmp_path):
    (tmp_path/'device-lease.json').write_text(json.dumps(dict(epoch='a',until=50)))
    with pytest.raises(ValueError): ExecutionGuard(tmp_path,'local:a',epoch='b',now=lambda:0).check()
    with pytest.raises(ValueError): ExecutionGuard(tmp_path,'local:a',epoch='a',now=lambda:51).check()

def test_creator_nickname_is_never_identity_evidence():
    creator=dict(loggedIn=True,name='Same',handle='a',userId='id-a')
    web=dict(loggedIn=True,name='Same',redId='b',userId='id-b')
    assert verify_session_identity(creator,web)['stage']=='mismatch'
    assert not verify_session_identity({**creator,'handle':''},web)['loggedIn']
    assert verify_session_identity(creator,{**web,'redId':'a','userId':'id-a'})['loggedIn']

def test_persisted_draft_requires_exact_uploaded_file_ids():
    task=dict(title='t',body='b',tags=[],images=['1','2'])
    row=dict(draftId='d',title='t',body='b',tags=[],images=[dict(fileId='a',status=2),dict(fileId='b',status=2)])
    snapshot=dict(available=True,matches=1,records=[row])
    assert verify_persisted_draft(snapshot,task,['a','b'])['draftId']=='d'
    with pytest.raises(ValueError): verify_persisted_draft(snapshot,task,['b','a'])
    with pytest.raises(ValueError): verify_persisted_draft(snapshot,{**task,'body':'different'},['a','b'])

def test_outbox_replays_until_ack_and_holds_changed_account(tmp_path):
    async def scenario():
        sent=[]
        async def send(event): sent.append(event)
        out=EventOutbox(tmp_path,on_event=send,max_pending=1)
        sub=dict(profile='local:a',accountId='a',handle='42',knownNotes=[],knownComments=[],knownMessages=[])
        await out.set_subscriptions([sub]); await out.emit('local:a','notes',['n'])
        assert len(sent)==1 and out.status()['status']=='paused'
        restored=EventOutbox(tmp_path,on_event=send,max_pending=1)
        await restored.set_subscriptions([{**sub,'handle':'other'}])
        assert len(sent)==1 and restored.status()['heldPending']==1
        await restored.set_subscriptions([sub]); assert len(sent)==2
        assert restored.ack(sent[0]['eventId'])
        assert restored.status()['pending']==0
    run(scenario())

def test_interrupted_upload_is_blocked_and_duplicate_does_not_execute(tmp_path):
    async def scenario():
        calls=[]
        async def executor(input,progress):
            calls.append(input['runId']); await progress(dict(uploadAttempted=True)); raise ResultUnknown('timeout')
        jobs=JobManager(tmp_path,studio_executor=executor,allowed_base='https://a.example')
        body=dict(runId='c9014397-9dd5-4daa-8f84-4918408414fd',taskId='c9014397-9dd5-4daa-8f84-4918408414fe',profile='local:a',apiBase='https://a.example',token='x'*64,startedAt='2026-10-13T00:00:00Z')
        jobs.now=lambda: 1791849600
        await jobs.submit_studio(body); await jobs.wait_idle()
        state=jobs.studio_state(body['runId'])
        assert state['status']=='blocked' and state['retrySafe'] is False and state['stopConfirmed']
        await jobs.submit_studio(body); assert len(calls)==1
        # Restart cannot re-enqueue an existing interrupted receipt.
        again=JobManager(tmp_path,studio_executor=executor,allowed_base='https://a.example')
        await again.submit_studio(body); assert len(calls)==1
    run(scenario())

def test_queue_cancel_returns_confirmed_stop_only_after_worker_exit(tmp_path):
    async def scenario():
        started=asyncio.Event()
        async def executor(input,progress):
            started.set(); await asyncio.Event().wait()
        jobs=JobManager(tmp_path,sync_executor=executor)
        id='c9014397-9dd5-4daa-8f84-4918408414fd'
        await jobs.submit_sync(id,dict(target=dict(id='a',handle='42',profile='local:a'),knownNotes=[]))
        await started.wait(); state=await jobs.cancel('sync',id)
        assert state['status']=='stopping' and state['stopConfirmed'] is False
        await jobs.wait_idle(); state=jobs.sync_state(id)
        assert state['status']=='cancelled' and state['stopConfirmed']
    run(scenario())

def test_cloud_streaming_rpc_blocks_unknown_commands_and_chunks(tmp_path):
    async def scenario():
        import httpx
        messages=[]
        async def handler(request): return httpx.Response(200,content=b'x'*100000,headers={'content-type':'application/octet-stream'})
        class WS:
            async def send(self,s): messages.append(json.loads(s))
        channel=CloudChannel(dict(cloudUrl='https://a.example',deviceToken='a'*64),root=tmp_path,port=47821,token='b'*64,client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        await channel.run_request(WS(),dict(id='a',method='POST',path='/eval'))
        assert messages==[dict(type='error',id='a')]
        messages.clear(); await channel.run_request(WS(),dict(id='b',method='GET',path='/verify'))
        import base64
        chunks=[base64.b64decode(m['data']) for m in messages if m['type']=='chunk']
        assert all(len(c)<=49152 for c in chunks) and b''.join(chunks)==b'x'*100000
        assert messages[-1]['type']=='end'
        await channel.client.aclose()
    run(scenario())
