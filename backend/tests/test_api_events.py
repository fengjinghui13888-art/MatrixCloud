import asyncio
import json
from types import SimpleNamespace
import pytest
from app.api import create_app
from app.settings import Settings
from app.event_sync import EventSync


def event(number, kind='comments'):
    return dict(eventId=f'00000000-0000-4000-8000-{number:012}', profile='local:synthetic', kind=kind, fingerprint='a' * 64)


def fixture(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, service_token='s' * 64))
    scope = app.state.services.for_workspace('owner')
    scope.store.add_account(dict(id='a', name='Account A', handle='10001', profile='local:synthetic', avatar='', state='connected', followers=0, lastSyncedAt=''))
    state = {'device': 'd', 'busy': False, 'online': True}
    jobs, calls = {}, []
    async def health(*args):
        if args[-1] == '/verify': return dict(version=4, capabilities=['event-sync', 'stop-ack'])
        return dict(creatorLoggedIn=True, webLoggedIn=True, handle='10001', webHandle='10001')
    async def online(device): return state['online']
    async def watch(*args): pass
    channel = SimpleNamespace(binding=lambda *args: state['device'], online=online, json=health, watch=watch)
    async def start(account, profile, options):
        job = dict(id='job-' + str(len(calls) + 1), accountId=account, profile=profile, status='running')
        calls.append(options)
        jobs[job['id']] = job
        return job
    execution = SimpleNamespace(scope=scope, channel=channel, busy=lambda account: state['busy'], running=lambda account: False, start=start, status=lambda identifier: jobs.get(identifier))
    queue = EventSync(execution)
    return queue, execution, jobs, calls, state


@pytest.mark.asyncio
async def test_event_restart_reconciles_success_without_relaunch(tmp_path):
    queue, execution, jobs, calls, state = fixture(tmp_path)
    await queue.set_enabled(True)
    assert await queue.receive(dict(workspace='owner', deviceId='d', event=event(1)))
    await queue.drain()
    assert len(calls) == 1
    jobs['job-1'].update(status='partial', finishedAt='done')
    restored = EventSync(execution)
    await restored.drain()
    assert restored.status()['accounts'][0]['status'] == 'idle'
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_disabled_event_ack_and_old_device_hints_never_move(tmp_path):
    queue, execution, jobs, calls, state = fixture(tmp_path)
    incoming = dict(workspace='owner', deviceId='d', event=event(2))
    assert await queue.receive(incoming)
    await queue.set_enabled(True)
    assert await queue.receive(incoming)
    assert calls == []
    state['busy'] = True
    assert await queue.receive(dict(workspace='owner', deviceId='d', event=event(3)))
    await queue.drain()
    state.update(busy=False, device='new')
    await queue.drain('new')
    assert queue.status()['accounts'][0]['status'] == 'paused'
    assert calls == []


@pytest.mark.asyncio
async def test_sync_checkpoint_survives_later_device_interruption(tmp_path):
    from app.sync import WorkspaceExecution
    from app.gateway import ExecutionGrants, ConnectorError
    queue, unused, jobs, calls, state = fixture(tmp_path)
    scope = unused.scope
    account = scope.store.list_accounts()[0]
    note = dict(id='synthetic-note', accountId='a', title='已读内容', summary=None, cover=None, url=None, publishedAt='', metrics=dict(likes=None, collects=None, comments=None, shares=None))
    polling = 0
    async def transport(workspace, device, method, path, body=None):
        nonlocal polling
        if method == 'POST': return {'stopConfirmed': False}
        if path.endswith('/result'): return dict(account=account, notes=[note], comments=[], messages=[])
        polling += 1
        if polling > 1: raise ConnectorError(503, 'synthetic device interruption')
        return dict(status='running', stage='notes', checkpoint=True)
    channel = SimpleNamespace(binding=lambda *args: 'd', json=transport)
    execution = WorkspaceExecution(scope, channel, ExecutionGrants(), 'http://localhost')
    job = dict(id='00000000-0000-4000-8000-000000000111', accountId='a', profile='local:synthetic', status='running', stage='starting', counts=dict(notes=0, comments=0, messages=0), startedAt='2026-01-01T00:00:00Z')
    execution.jobs[job['id']] = job
    await execution._collect(job, account, 'd', {})
    assert execution.status(job['id'])['status'] == 'blocked'
    assert scope.store.list_notes({'accountId': 'a'})[0]['id'] == 'synthetic-note'


@pytest.mark.asyncio
async def test_durable_sync_cancel_sends_stop_when_job_is_not_in_memory(tmp_path):
    from app.sync import WorkspaceExecution
    from app.gateway import ExecutionGrants
    queue, unused, jobs, calls, state = fixture(tmp_path)
    captured = []
    async def stop(workspace, device, method, path, body):
        captured.append((workspace, device, method, path))
        return dict(stopConfirmed=True)
    channel = SimpleNamespace(binding=lambda *args: 'd', json=stop)
    execution = WorkspaceExecution(unused.scope, channel, ExecutionGrants(), 'http://localhost')
    job = dict(id='00000000-0000-4000-8000-000000000222', accountId='a', profile='local:synthetic', status='running', stage='notes', counts=dict(notes=1, comments=0, messages=0), startedAt='synthetic')
    def update(identifier, patch):
        job.update(patch)
        return job
    execution.durable = SimpleNamespace(read=lambda identifier: job, update=update)
    assert execution.jobs == {}
    result = await execution.cancel(job['id'])
    assert result['status'] == 'blocked' and result['stopConfirmed'] is True
    assert captured == [('owner', 'd', 'POST', '/sync/' + job['id'] + '/cancel')]
