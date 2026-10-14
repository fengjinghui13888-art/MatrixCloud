from types import SimpleNamespace
import pytest
from connector.draft import DraftExecutor
from connector.browser import CREATOR
from app.protocols import valid_connector_command

@pytest.mark.asyncio
@pytest.mark.parametrize('identity_ok,visible_ok',[(True,True),(False,True),(True,False)])
async def test_open_saved_is_read_only_and_requires_identity_and_exact_draft(tmp_path,identity_ok,visible_ok):
    calls=[]
    async def foreground():calls.append('foreground')
    async def new_page(url):calls.append(url)
    async def close():calls.append('close')
    connection=SimpleNamespace(foreground=foreground,new_page=new_page,close=close)
    async def connect(profile,**kwargs):
        assert profile=='local:a' and kwargs==dict(guard=True,open_creator=True)
        return connection
    async def state(id):return dict(loggedIn=identity_ok,handle='42')
    executor=DraftExecutor(tmp_path,SimpleNamespace(connect=connect,state=state))
    async def visible(*args):return dict(matches=1,draftIds=['d'] if visible_ok else ['other'])
    executor.confirm_visible=visible
    body=dict(title='Saved',draftId='d',handle='42')
    if identity_ok and visible_ok:assert await executor.open_saved('local:a',body)==dict(opened=True,draftId='d')
    else:
        with pytest.raises(ValueError):await executor.open_saved('local:a',body)
    assert calls[-1]=='close'
    assert (CREATOR+'/publish/publish?from=menu_left&target=image' in calls)==identity_ok

def test_draft_view_protocol_rejects_executable_or_arbitrary_inputs():
    body=dict(title='Saved',draftId='075a4683-3bb1-4684-b9a7-8926a7898836',handle='42')
    assert valid_connector_command('POST','/accounts/a/drafts',body)
    assert not valid_connector_command('POST','/accounts/a/drafts',{**body,'url':'https://evil.test'})
    assert not valid_connector_command('POST','/accounts/a/drafts',{**body,'draftId':'bad'})
