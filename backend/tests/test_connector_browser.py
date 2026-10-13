import asyncio
import json
import pytest
from connector.content import extract_content, verified_incremental_note_ownership, needs_note_detail
from connector.draft import should_fallback_native, upload_with_preview, DraftExecutor
from connector.cdp import browser_version,validate_cdp_url
from connector.media import validate_media_url,download_images

def run(coro):return asyncio.run(coro)

def test_public_content_cannot_establish_incremental_ownership():
    target=dict(id='a',handle='42')
    known=[dict(id='own',accountId='a'),dict(id='other',accountId='b')]
    creator=dict(userId='u',redId='42'); web=dict(user_id='u',red_id='42')
    assert verified_incremental_note_ownership('incremental',target,known,creator,web)=={'own'}
    assert not verified_incremental_note_ownership('incremental',target,known,creator,{**web,'guest':True})
    assert not verified_incremental_note_ownership('incremental',target,known,creator,{**web,'user_id':'v'})

def test_content_uses_only_returned_fields_and_filters_group_messages():
    payload=dict(data=dict(notes=[dict(id='n',title='t',type='normal',desc='body',image_list=[dict(url='https://a.xhscdn.com/a')])],out_message_list=[dict(id='m',sender_id='u',receiver_id='p',content=json.dumps(dict(content='hello')),created_at=1700000000),dict(id='group',sender_id='u',receiver_id='p',group_chat=True,content='hello')]))
    found=extract_content(payload,'a',dict(selfId='u',selfName='Me'))
    assert found['notes'][0]['summary']=='body'
    assert found['notes'][0]['metrics']['likes'] is None
    assert [m['id'] for m in found['messages']]==['m']
    assert needs_note_detail(dict(summary='body',mediaType='image',images=[]))

def test_distinct_notification_comments_are_not_lost_to_temporary_object_reuse():
    items=[dict(comment_info=dict(id='c'+str(i),content='body'),item_info=dict(id='n'),user_info=dict(nickname='reader')) for i in range(10)]
    result=extract_content(dict(message_list=items),'a')
    assert [c['id'] for c in result['comments']]==['c'+str(i) for i in range(10)]

def test_unknown_native_upload_never_falls_back():
    async def scenario():
        called=[]
        async def native(): called.append('native'); raise TimeoutError('result unknown')
        async def fallback():called.append('fallback')
        async def read(timeout):return dict(editor=False,imageCount=0,pendingImageCount=0)
        with pytest.raises(TimeoutError): await upload_with_preview(native,fallback,read,expected=12)
        assert called==['native']
    run(scenario())

def test_capability_fallback_rejects_partial_upload():
    async def scenario():
        called=[]
        async def native():raise ValueError('DOM.setFileInputFiles method not found')
        async def fallback():called.append(True)
        async def read(timeout):return dict(editor=True,imageCount=1,pendingImageCount=1)
        with pytest.raises(ValueError):await upload_with_preview(native,fallback,read,expected=12)
        assert not called
    run(scenario())

def test_cdp_browser_identity_cannot_change_between_saved_and_live(tmp_path):
    import httpx
    async def scenario():
        client=httpx.AsyncClient(transport=httpx.MockTransport(lambda req:httpx.Response(200,json=dict(webSocketDebuggerUrl='ws://127.0.0.1:9222/devtools/browser/other'))))
        with pytest.raises(ValueError):await browser_version(dict(debugPort=9222,browserUrl='ws://127.0.0.1:9222/devtools/browser/expected'),client)
        await client.aclose()
    run(scenario())
    for url in ('ws://evil.example:9222/path','wss://127.0.0.1:9222/path','ws://127.0.0.1:9223/path'):
        with pytest.raises(ValueError):validate_cdp_url(url,9222)

def test_media_rejects_non_platform_redirect_and_non_image(tmp_path):
    import httpx
    for url in ('https://evil.example/a','https://xhscdn.com.evil.example/a','http://127.0.0.1/a','https://u:p@a.xhscdn.com/a'):
        with pytest.raises(ValueError): validate_media_url(url)
    async def scenario():
        client=httpx.AsyncClient(transport=httpx.MockTransport(lambda req:httpx.Response(200,content=b'not image')))
        with pytest.raises(ValueError):await download_images(['https://a.example/a'],tmp_path,client=client)
        await client.aclose()
    run(scenario())

def test_native_chrome_launch_retains_detached_login_window_on_connector_exit(tmp_path,monkeypatch):
    from connector.browser import BrowserRuntime
    import connector.browser as browser_module
    from types import SimpleNamespace
    launches=[]
    def launcher(executable,directory):
        launches.append((executable,directory))
        (directory/'DevToolsActivePort').write_text('9222\n/devtools/browser/account-a\n')
        return SimpleNamespace(pid=12345)
    async def version(session):return dict(webSocketDebuggerUrl=session['browserUrl'])
    monkeypatch.setattr(browser_module,'browser_version',version)
    async def scenario():
        runtime=BrowserRuntime(tmp_path,browser_launcher=launcher); runtime.executable=lambda:'fake-chrome'
        session=await runtime.ensure('a')
        assert session['pid']==12345 and session['profile']=='local:a'
        assert len(launches)==1 and runtime.playwright is None
        await runtime.close()
        assert (tmp_path/'a'/'session.json').exists()
    run(scenario())

def test_browser_discovery_keeps_edge_fallback_and_chrome_bin(tmp_path,monkeypatch):
    from connector.browser import chrome_candidates,BrowserRuntime
    paths=chrome_candidates('win32',{'LOCALAPPDATA':str(tmp_path),'CHROME_BIN':'custom-browser'},str(tmp_path))
    assert paths[0]=='custom-browser'
    assert any(path.endswith('Microsoft/Edge/Application/msedge.exe') or path.endswith('Microsoft\\Edge\\Application\\msedge.exe') for path in paths)
    edge=tmp_path/'Microsoft'/'Edge'/'Application'/'msedge.exe';edge.parent.mkdir(parents=True);edge.write_bytes(b'fake')
    monkeypatch.setenv('LOCALAPPDATA',str(tmp_path))
    for key in ('CHROME_BIN','MATRIX_CHROME_PATH','ProgramFiles','PROGRAMFILES','ProgramFiles(x86)','PROGRAMFILES(X86)'):monkeypatch.delenv(key,raising=False)
    assert BrowserRuntime(tmp_path).executable()==str(edge)

def test_qr_login_and_capture_operate_only_on_bound_browser(tmp_path):
    from connector.browser import BrowserRuntime
    from types import SimpleNamespace
    actions=[]
    web=SimpleNamespace(url='https://www.xiaohongshu.com/login')
    class Connection:
        context=SimpleNamespace(pages=[SimpleNamespace(url='https://creator.xiaohongshu.com/login'),web])
        async def foreground(self):actions.append('foreground')
        async def select(self,page):assert page is web;actions.append('select-web')
        async def evaluate(self,source):
            if 'function readIdentity' in source:return dict(loggedIn=False)
            if 'toggle:' in source:return dict(qr=True,toggle=False)
            return dict(x=1,y=2,width=120,height=120,scale=1)
        async def cdp(self,method,params):assert method=='Page.captureScreenshot' and params['clip']['width']==120;return dict(data='png-base64')
        async def close(self):actions.append('disconnect')
    async def scenario():
        runtime=BrowserRuntime(tmp_path)
        async def ensure(id):assert id=='a'
        async def connect(profile,**kwargs):assert profile=='local:a';return Connection()
        async def state(id):return dict(stage='web')
        runtime.ensure=ensure;runtime.connect=connect;runtime.state=state
        assert (await runtime.login('a'))['profile']=='local:a'
        assert (await runtime.qr('a'))['data']=='png-base64'
        assert actions==['foreground','disconnect','select-web','disconnect']
    run(scenario())

def test_external_image_dns_cannot_resolve_to_private_network():
    from connector.media import fetch_pinned_image_bytes
    calls=[]
    def resolver(*args):return [(2,1,6,'',('127.0.0.1',443))]
    def connection(*args):calls.append(args);raise AssertionError('blocked DNS must not connect')
    async def scenario():
        with pytest.raises(ValueError):await fetch_pinned_image_bytes('https://images.example/a.png',resolver=resolver,connection_factory=connection)
        assert not calls
    run(scenario())

def test_read_only_image_download_retries_transient_response_without_changing_bytes(tmp_path,monkeypatch):
    import connector.media as media
    calls=[];original=b'\x89PNG\r\n\x1a\noriginal-image'
    async def fetch(url):
        calls.append(url)
        if len(calls)<3:raise media.MediaHTTPError(503)
        return original
    async def delay(seconds):pass
    monkeypatch.setattr(media,'fetch_pinned_image_bytes',fetch);monkeypatch.setattr(media.asyncio,'sleep',delay)
    async def scenario():
        result=await media.download_images(['https://images.example/a.png'],tmp_path)
        assert len(calls)==3 and result[0]['bytes']==len(original)
        assert (tmp_path/'1.png').read_bytes()==original
    run(scenario())

def test_account_removal_closes_verified_browser_after_restart_and_retains_profile(tmp_path,monkeypatch):
    import connector.browser as module
    from connector.files import atomic_json
    profile=tmp_path/'a'/'chrome-profile';profile.mkdir(parents=True);(profile/'Cookies').write_bytes(b'login')
    session=dict(id='a',profile='local:a',pid=123,debugPort=9222,browserUrl='ws://127.0.0.1:9222/devtools/browser/a');atomic_json(tmp_path/'a'/'session.json',session)
    called=[]
    class CDP:
        @classmethod
        async def open(cls,url):assert url==session['browserUrl'];return cls()
        async def send(self,method):called.append(method);return {}
        async def close(self):pass
    async def version(value):return dict(webSocketDebuggerUrl=value['browserUrl'])
    monkeypatch.setattr(module,'RawCDP',CDP);monkeypatch.setattr(module,'browser_version',version)
    async def scenario():
        runtime=module.BrowserRuntime(tmp_path);await runtime.remove('a')
        assert called==['Browser.close'] and (profile/'Cookies').read_bytes()==b'login'
    run(scenario())
