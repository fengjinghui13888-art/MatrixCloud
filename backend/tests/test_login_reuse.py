from types import SimpleNamespace
import pytest
from app.sync import WorkspaceExecution
from app.gateway import ExecutionGrants


@pytest.mark.asyncio
@pytest.mark.parametrize('handle,expected',[('42','authenticated'),('other','failed')])
async def test_existing_authenticated_window_never_opens_login_or_changes_profile(tmp_path,handle,expected):
    account=dict(id='a',name='Synthetic',handle='42',profile='local:original',avatar='',followers=1,lastSyncedAt='',state='connected')
    calls=[];imports=[]
    class Channel:
        pairing=SimpleNamespace(device_by_id=lambda *args:dict(name='Synthetic PC'))
        def binding(self,*args):return 'device'
        async def bind(self,*args):calls.append(('bind',args))
        async def json(self,workspace,device,method,path):
            calls.append((method,path))
            if method!='GET':raise AssertionError('must not open login or create another browser')
            return dict(connected=True,loggedIn=True,creatorLoggedIn=True,webLoggedIn=True,handle=handle,webHandle=handle,name='Synthetic')
    scope=SimpleNamespace(root=tmp_path,workspace='fixture',store=SimpleNamespace(list_accounts=lambda:[account],import_snapshot=imports.append))
    execution=WorkspaceExecution(scope,Channel(),ExecutionGrants(),'')
    result=await execution.login_start('a','device')
    assert result['status']==expected
    assert result['sessionId']=='original'
    assert all(call[0]!='POST' for call in calls)
    assert len(imports)==(1 if expected=='authenticated' else 0)
