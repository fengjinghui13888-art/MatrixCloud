from types import SimpleNamespace
import httpx
import pytest
from connector.browser import BrowserRuntime,CREATOR,WEB

@pytest.mark.asyncio
async def test_closed_browser_reopens_same_profile_before_connect(tmp_path,monkeypatch):
    runtime=BrowserRuntime(tmp_path);old=dict(debugPort=1111);new=dict(debugPort=2222);calls=[]
    runtime.load=lambda id:old
    async def ensure(id):calls.append(id);return new
    runtime.ensure=ensure
    async def version(session):
        if session is old:raise httpx.ConnectError('closed')
        return dict(webSocketDebuggerUrl='ws://127.0.0.1:2222/devtools/browser/new')
    monkeypatch.setattr('connector.browser.browser_version',version)
    context=SimpleNamespace(pages=[SimpleNamespace(url=CREATOR+'/new/home'),SimpleNamespace(url=WEB+'/explore')],set_default_timeout=lambda _:None,set_default_navigation_timeout=lambda _:None,on=lambda *a:None)
    async def connect(url,**kwargs):return SimpleNamespace(contexts=[context])
    async def engine():return SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=connect))
    runtime.engine=engine
    connection=await runtime.connect('local:qa-profile')
    assert calls==['qa-profile'] and connection.context is context

@pytest.mark.asyncio
async def test_changed_browser_identity_never_triggers_automatic_relaunch(tmp_path,monkeypatch):
    runtime=BrowserRuntime(tmp_path);runtime.load=lambda _:dict(debugPort=1111)
    async def version(_):raise ValueError('Chrome 浏览器身份已改变')
    monkeypatch.setattr('connector.browser.browser_version',version)
    with pytest.raises(ValueError,match='身份已改变'):await runtime.connect('local:qa-profile')

@pytest.mark.asyncio
async def test_sync_connect_restores_missing_platform_tabs(tmp_path,monkeypatch):
    runtime=BrowserRuntime(tmp_path);runtime.load=lambda _:dict(debugPort=1111)
    async def version(_):return dict(webSocketDebuggerUrl='ws://127.0.0.1:1111/devtools/browser/a')
    monkeypatch.setattr('connector.browser.browser_version',version)
    visits=[]
    context=SimpleNamespace(pages=[],set_default_timeout=lambda _:None,set_default_navigation_timeout=lambda _:None,on=lambda *a:None)
    async def new_page():
        page=SimpleNamespace(url='about:blank')
        async def goto(url,**kwargs):page.url=url;visits.append(url)
        page.goto=goto;context.pages.append(page);return page
    context.new_page=new_page
    async def connect(url,**kwargs):return SimpleNamespace(contexts=[context])
    async def engine():return SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=connect))
    runtime.engine=engine
    await runtime.connect('local:qa-profile',guard=True,open_creator=True)
    assert visits==[CREATOR+'/new/home',WEB+'/explore']
