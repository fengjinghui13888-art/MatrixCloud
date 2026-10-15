import asyncio
import uuid
import pytest
from connector.jobs import JobManager

@pytest.mark.asyncio
async def test_different_accounts_run_independently_and_cancel_is_scoped(tmp_path):
    starts={p:asyncio.Event() for p in ['a','b']}
    releases={p:asyncio.Event() for p in starts}
    async def execute(body,progress):
        p=body['target']['id'];starts[p].set();await releases[p].wait()
    manager=JobManager(tmp_path,sync_executor=execute)
    ids={p:str(uuid.uuid4()) for p in starts}
    try:
        for p in starts:
            await manager.submit_sync(ids[p],dict(target=dict(id=p,handle=p,profile='local:'+p),knownNotes=[]))
        await asyncio.wait_for(asyncio.gather(*(e.wait() for e in starts.values())),.3)
        await manager.cancel('sync',ids['a'])
        releases['b'].set();await manager.wait_idle()
        assert manager.sync_state(ids['a'])['status']=='cancelled'
        assert manager.sync_state(ids['b'])['status']=='complete'
        assert not manager.busy()
    finally:
        await manager.close()

@pytest.mark.asyncio
async def test_same_account_duplicate_job_still_rejected(tmp_path):
    started=asyncio.Event()
    async def execute(body,progress):started.set();await asyncio.Event().wait()
    manager=JobManager(tmp_path,sync_executor=execute)
    body=dict(target=dict(id='a',handle='a',profile='local:a'),knownNotes=[])
    try:
        await manager.submit_sync(str(uuid.uuid4()),body);await started.wait()
        with pytest.raises(ValueError,match='此账号'):
            await manager.submit_sync(str(uuid.uuid4()),body)
    finally:await manager.close()


@pytest.mark.asyncio
async def test_worker_limit_and_close_preserve_pending_cancellation(tmp_path):
    starts=[];release=asyncio.Event()
    async def execute(body,progress):
        starts.append(body['target']['id']);await release.wait()
    manager=JobManager(tmp_path,sync_executor=execute)
    ids=[str(uuid.uuid4()) for _ in range(4)]
    for i,id in enumerate(ids):
        await manager.submit_sync(id,dict(target=dict(id=str(i),handle=str(i),profile='local:'+str(i)),knownNotes=[]))
    for _ in range(30):
        if len(starts)==2:break
        await asyncio.sleep(.005)
    assert len(starts)==2
    await asyncio.wait_for(manager.close(),1)
    assert not manager.busy() and not manager.profile_jobs
    assert all(manager.sync_state(id)['status']=='cancelled' for id in ids)
