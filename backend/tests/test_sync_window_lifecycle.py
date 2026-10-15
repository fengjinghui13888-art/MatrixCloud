import asyncio
from types import SimpleNamespace
import pytest
from connector.browser import BrowserConnection,CREATOR,WEB
from connector.sync import SyncExecutor
from connector.jobs import JobManager
from app.sync import WorkspaceExecution
from app.gateway import ExecutionGrants
from connector.files import atomic_json


@pytest.mark.asyncio
async def test_window_closure_aborts_waiting_collection_and_releases_queue(tmp_path):
    closed=asyncio.Event();started=asyncio.Event();stopped=asyncio.Event()
    class Connection:
        async def wait_until_window_closed(self):
            await closed.wait();raise ValueError('同步失败：小红书窗口已关闭')
    class Executor(SyncExecutor):
        async def _run(self,body,progress,ready):
            ready.set_result(Connection());started.set()
            try:await asyncio.Future()
            finally:stopped.set()
    manager=JobManager(tmp_path,sync_executor=Executor(tmp_path,None))
    body=dict(target=dict(id='a',profile='local:a',handle='42'),knownNotes=[])
    id='c9014397-9dd5-4daa-8f84-4918408414fd'
    await manager.submit_sync(id,body);await started.wait();closed.set()
    await asyncio.wait_for(manager.wait_idle(),1)
    state=manager.sync_state(id)
    assert stopped.is_set() and state['status']=='blocked' and state['stopConfirmed']
    assert '同步失败' in state['message'] and not manager.busy() and not manager.profile_jobs


@pytest.mark.asyncio
async def test_connection_watches_account_page_close_without_launching_browser():
    closed=False
    page=SimpleNamespace(url=CREATOR+'/new/home',is_closed=lambda:closed)
    context=SimpleNamespace(pages=[page],on=lambda *a:None)
    connection=BrowserConnection(SimpleNamespace(is_connected=lambda:True),context,page)
    monitor=asyncio.create_task(connection.wait_until_window_closed());await asyncio.sleep(0)
    closed=True
    with pytest.raises(ValueError,match='窗口已关闭'):await asyncio.wait_for(monitor,1)


@pytest.mark.asyncio
async def test_existing_account_login_reuses_bound_profile_and_closed_login_finishes(tmp_path):
    account=dict(id='a',name='Account',handle='42',profile='local:original')
    calls=[]
    class Channel:
        pairing=SimpleNamespace(device_by_id=lambda *a:dict(name='测试电脑'))
        def binding(self,workspace,profile):return 'original-device'
        async def bind(self,*args):calls.append(('bind',args))
        async def json(self,workspace,device,method,path):
            calls.append((method,path))
            return dict(connected=False,loggedIn=False) if method=='GET' else dict(stopConfirmed=True)
    scope=SimpleNamespace(root=tmp_path,workspace='fixture',store=SimpleNamespace(list_accounts=lambda:[account]))
    execution=WorkspaceExecution(scope,Channel(),ExecutionGrants(),'')
    job=await execution.login_start('a','original-device')
    assert job['sessionId']=='original' and ('POST','/accounts/original/login') in calls
    result=await execution.login_status(job['id'])
    assert result['status']=='failed' and '窗口已关闭' in result['message']
    assert ('POST','/accounts/original/cancel') in calls
    # Switching to another execution computer must get a distinct profile.
    second=await execution.login_start('a','another-device')
    assert second['sessionId']!='original'
