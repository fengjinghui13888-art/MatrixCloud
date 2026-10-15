from types import SimpleNamespace
import httpx
import pytest
from connector.browser import BrowserRuntime,CREATOR,WEB
from connector.files import atomic_json,read_json
import asyncio
import os

def test_process_probe_does_not_terminate_current_process():
    from connector.browser import process_alive
    assert process_alive(os.getpid()) is True
    assert process_alive(None) is True

def test_native_start_does_not_force_new_window_or_login_page(tmp_path,monkeypatch):
    args=[]
    def popen(command,**kwargs):args.extend(command);return SimpleNamespace(pid=123)
    monkeypatch.setattr('connector.browser.subprocess.Popen',popen)
    BrowserRuntime.launch_native_browser('fake-chrome',tmp_path)
    assert '--new-window' not in args
    assert args[-1]==CREATOR+'/new/home'

@pytest.mark.asyncio
async def test_two_runtimes_one_account_launch_once_but_new_account_has_own_browser(tmp_path,monkeypatch):
    launches=[]
    def launcher(_,directory):
        launches.append(directory)
        (directory/'DevToolsActivePort').write_text('9222\n/devtools/browser/'+directory.parent.name)
        return SimpleNamespace(pid=123)
    async def version(session):return dict(webSocketDebuggerUrl=session['browserUrl'])
    monkeypatch.setattr('connector.browser.browser_version',version)
    a=BrowserRuntime(tmp_path,browser_launcher=launcher);b=BrowserRuntime(tmp_path,browser_launcher=launcher)
    a.executable=b.executable=lambda:'fake-chrome'
    results=await asyncio.gather(a.ensure('a'),b.ensure('a'),return_exceptions=True)
    assert len(launches)==1
    assert any(isinstance(r,dict) for r in results)
    await b.ensure('b')
    assert len(launches)==2 and launches[0]!=launches[1]

@pytest.mark.asyncio
async def test_late_start_reconnects_without_second_launch(tmp_path,monkeypatch):
    atomic_json(tmp_path/'a/session.json',dict(id='a',profile='local:a',pid=123,starting=True))
    directory=tmp_path/'a/chrome-profile';directory.mkdir()
    (directory/'DevToolsActivePort').write_text('9222\n/devtools/browser/a')
    async def version(session):return dict(webSocketDebuggerUrl=session['browserUrl'])
    monkeypatch.setattr('connector.browser.browser_version',version)
    monkeypatch.setattr('connector.browser.process_alive',lambda _:True)
    runtime=BrowserRuntime(tmp_path)
    def forbidden(*_):raise AssertionError('late-start browser must be reconnected')
    runtime.browser_launcher=forbidden
    session=await runtime.ensure('a')
    assert session['debugPort']==9222 and not session['starting']

@pytest.mark.asyncio
async def test_existing_process_with_broken_connection_never_opens_another_window(tmp_path,monkeypatch):
    session=dict(id='a',profile='local:a',pid=123,debugPort=1111)
    atomic_json(tmp_path/'a/session.json',session)
    active=tmp_path/'a/chrome-profile/DevToolsActivePort';active.parent.mkdir();active.write_text('1111\n/devtools/browser/old')
    runtime=BrowserRuntime(tmp_path)
    async def disconnected(_):return False
    runtime.live=disconnected
    monkeypatch.setattr('connector.browser.process_alive',lambda _:True,raising=False)
    def forbidden(*_):raise AssertionError('connection failure must not duplicate a live browser')
    runtime.browser_launcher=forbidden
    with pytest.raises(ValueError,match='已有浏览器仍在运行'):await runtime.ensure('a')
    assert active.read_text()=='1111\n/devtools/browser/old'
    assert read_json(tmp_path/'a/session.json')==session

@pytest.mark.asyncio
async def test_startup_timeout_retains_pid_and_forbids_second_launch(tmp_path,monkeypatch):
    launches=[];runtime=BrowserRuntime(tmp_path)
    runtime.executable=lambda:'fake-chrome'
    def launch(*_):launches.append(1);return SimpleNamespace(pid=456)
    runtime.browser_launcher=launch
    async def disconnected(_):return False
    runtime.live=disconnected
    async def timeout(*_):return None
    monkeypatch.setattr('connector.browser.until',timeout)
    monkeypatch.setattr('connector.browser.process_alive',lambda _:True,raising=False)
    with pytest.raises(ValueError):await runtime.ensure('a')
    assert read_json(tmp_path/'a/session.json')['pid']==456
    with pytest.raises(ValueError,match='已有浏览器仍在运行'):await runtime.ensure('a')
    assert launches==[1]

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


@pytest.mark.asyncio
async def test_existing_account_window_is_reused_without_launch_or_new_tabs(tmp_path,monkeypatch):
    runtime=BrowserRuntime(tmp_path);runtime.load=lambda _:dict(debugPort=1111)
    async def version(_):return dict(webSocketDebuggerUrl='ws://127.0.0.1:1111/devtools/browser/a')
    monkeypatch.setattr('connector.browser.browser_version',version)
    def forbidden(*a):raise AssertionError('must reuse existing account window')
    runtime.browser_launcher=forbidden
    context=SimpleNamespace(pages=[SimpleNamespace(url=CREATOR+'/new/home'),SimpleNamespace(url=WEB+'/chat')],set_default_timeout=lambda _:None,set_default_navigation_timeout=lambda _:None,on=lambda *a:None,new_page=forbidden)
    async def connect(url,**kwargs):return SimpleNamespace(contexts=[context])
    async def engine():return SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=connect))
    runtime.engine=engine
    result=await runtime.connect('local:qa-profile',guard=True,open_creator=True)
    assert result.page is context.pages[0]
