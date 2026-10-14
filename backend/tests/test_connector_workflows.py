"""Synthetic full workflows: no real platform, CDP port, browser or supplier."""
import asyncio
import json
from types import SimpleNamespace
import httpx
import pytest
from connector.draft import DraftExecutor
from connector.sync import SyncExecutor
from connector.safety import ExecutionGuard,ResultUnknown
from connector.files import read_json

def run(coro):return asyncio.run(coro)
async def no_wait():pass

class DraftPage:
    url='https://creator.xiaohongshu.com/publish/publish?target=image'

class DraftConnection:
    def __init__(self,root,task,unknown_save=False):
        self.task=task; self.page=DraftPage(); self.context=SimpleNamespace(pages=[self.page]); self.guard=ExecutionGuard(root,'local:a'); self.pace=no_wait
        self.uploads=0;self.saves=0;self.images=0;self.filled=False;self.persisted=False;self.drawer=False;self.unknown_save=unknown_save
    async def check(self):self.guard.check()
    async def select(self,page):self.page=page
    async def foreground(self):pass
    async def new_page(self,url):self.page=DraftPage();self.page.url=url;self.context.pages.append(self.page);return self.page
    def editor(self):return dict(editor=self.images>0 and not self.persisted,imageCount=self.images,pendingImageCount=self.images,title=self.task['title'] if self.filled else '',text=self.task['body'] if self.filled else '',topics=[])
    async def evaluate(self,source):
        if 'name:' in source and 'visible:!document.hidden' in source:return dict(name='Account',visible=True,input=True,**self.editor())
        if 'function readPersistedImageDraft' in source:
            return dict(available=True,matches=1 if self.persisted else 0,records=[dict(draftId='draft-1',title=self.task['title'],body=self.task['body'],tags=[],images=[dict(fileId='f'+str(i),status=2) for i in range(self.images)])] if self.persisted else [])
        if 'function readEditor' in source:return self.editor()
        if 'function inspectDraftList' in source:return dict(drawer=self.drawer,matches=1 if self.persisted else 0,draftIds=['draft-1'] if self.persisted else [])
        if 'function openImageDrafts' in source:self.drawer=True;return True
        if 'function refreshPlatformDraftList' in source:return dict(refreshed=True)
        if 'function fillEditor' in source:self.filled=True;return True
        if 'function readTitlePreview' in source:return True
        if 'function uploadedDraftFileIds' in source:return ['f'+str(i) for i in range(self.images)]
        if 'd-drawer-close' in source:self.drawer=False;return True
        if 'header-area' in source:return 'Account'
        return True
    async def cdp(self,method,params=None):
        if method=='DOM.getDocument':return dict(root=dict(nodeId=1))
        if method=='DOM.querySelectorAll':return dict(nodeIds=[2])
        if method=='DOM.setFileInputFiles':self.uploads+=1;self.images=len(params['files']);return {}
        if method=='Accessibility.getFullAXTree':return dict(nodes=[dict(role=dict(value='button'),name=dict(value='暂存离开'),backendDOMNodeId=4)])
        if method=='DOM.getBoxModel':return dict(model=dict(content=[0,0,100,0,100,40,0,40]))
        return {}
    async def native_click(self,x,y):
        self.saves+=1
        if self.unknown_save:raise ResultUnknown('save connection lost')
        self.persisted=True;self.filled=False
    async def insert_text(self,text):pass
    async def close(self):pass

def draft_case(tmp_path,unknown_save=False):
    task=dict(id='c9014397-9dd5-4daa-8f84-4918408414fe',status='approved',revision=1,accountId='a',title='批准标题',body='批准正文',tags=[],images=['/api/templates/media/'+str(i).zfill(64)+'.png' for i in range(12)])
    input=dict(taskId=task['id'],runId='c9014397-9dd5-4daa-8f84-4918408414fd',profile='local:a',apiBase='https://cloud.example',token='a'*64,startedAt='2026-10-13T00:00:00Z')
    receipts=[]
    def handler(request):
        if request.url.path=='/api/studio/'+task['id']:return httpx.Response(200,json=task)
        if request.url.path=='/api/operations':return httpx.Response(200,json=dict(accounts=[dict(id='a',name='Account',handle='42',profile='local:a')]))
        if '/media/' in request.url.path:return httpx.Response(200,content=b'\x89PNG\r\n\x1a\noriginal-'+request.url.path.encode())
        if request.url.path.endswith('/receipt'):receipts.append(json.loads(request.content));return httpx.Response(200,json=dict(executionElapsedMs=100))
        return httpx.Response(200,json=dict(revision=2))
    client=httpx.AsyncClient(transport=httpx.MockTransport(handler));connection=DraftConnection(tmp_path,task,unknown_save)
    class Runtime:
        async def connect(self,profile,guard=False,open_creator=False):
            assert open_creator is True
            return connection
        async def state(self,id):return dict(loggedIn=True,handle='42')
    return DraftExecutor(tmp_path,Runtime(),client=client),client,connection,input,receipts

def test_full_twelve_image_draft_returns_only_persisted_unique_receipt(tmp_path):
    async def scenario():
        execute,client,connection,input,receipts=draft_case(tmp_path)
        async def progress(p):pass
        result=await execute(input,progress)
        assert connection.uploads==1 and connection.saves==1
        assert result['status']=='filled' and result['persisted']['imageCount']==12
        assert receipts[-1]['status']=='filled' and receipts[-1]['draftId']=='draft-1' and receipts[-1]['imageCount']==12
        assert read_json(tmp_path.parent/'studio-executions'/(input['taskId']+'.json'))['status']=='filled'
        await client.aclose()
    run(scenario())

def test_unknown_save_cannot_upload_again_under_new_run_id(tmp_path):
    async def scenario():
        execute,client,connection,input,receipts=draft_case(tmp_path,True)
        async def progress(p):pass
        with pytest.raises(ResultUnknown):await execute(input,progress)
        # Simulate closing the uncertain editor. Receipt still forbids repeating upload.
        connection.filled=False;connection.images=0
        with pytest.raises(ResultUnknown):await execute({**input,'runId':'c9014397-9dd5-4daa-8f84-4918408414fc'},progress)
        with pytest.raises(ResultUnknown):await execute({**input,'runId':'c9014397-9dd5-4daa-8f84-4918408414fb'},progress)
        assert connection.uploads==1 and connection.saves==1
        assert all(r['status']!='filled' for r in receipts)
        await client.aclose()
    run(scenario())

class FakeContext:
    def __init__(self):self.listeners={};self.pages=[]
    def on(self,name,fn):self.listeners.setdefault(name,[]).append(fn)
    def remove_listener(self,name,fn):self.listeners[name].remove(fn)
    async def route(self,*args):pass
    async def unroute(self,*args):pass
    async def cookies(self):raise AssertionError('no missing media should ask for browser cookies')
    def emit(self,path,data):
        class Response:
            url='https://www.xiaohongshu.com'+path;status=200;headers={'content-type':'application/json'}
            async def json(self):return dict(data=data)
        for fn in self.listeners.get('response',[]):fn(Response())

class SyncPage:
    def __init__(self,context,url):self.context=context;self.url=url
    async def bring_to_front(self):pass
    async def goto(self,url,**kwargs):
        self.url=url
        if '/new/home' in url:self.context.emit('/api/galaxy/user/info',dict(redId='42',userId='u'))
        if '/new/note-manager' in url:self.context.emit('/api/galaxy/creator/note/user/posted',dict(notes=[dict(id='n',display_title='Owned',type='normal',images_list=[])],has_more=False))
        if '/notification' in url:
            self.context.emit('/api/sns/web/v1/user/selfinfo',dict(user_id='u',red_id='42'))
            self.context.emit('/api/sns/web/v2/you/mentions',dict(has_more=False,message_list=[dict(comment_info=dict(id='fresh',content='new'),item_info=dict(id='n'),user_info=dict(nickname='reader'))]))
        if '/chat' in url:
            self.context.emit('/api/sns/web/v1/user/selfinfo',dict(user_id='u',red_id='42'))
            self.context.emit('/api/im/web/v3/chats',dict(chats=[],total=0,next_ts=-1))

def test_full_incremental_sync_preserves_known_images_and_checkpoints(tmp_path):
    async def scenario():
        context=FakeContext();creator=SyncPage(context,'https://creator.xiaohongshu.com/new/home');web=SyncPage(context,'https://www.xiaohongshu.com/chat');context.pages=[creator,web]
        class Connection:
            def __init__(self):self.page=creator;self.context=context;self.guard=ExecutionGuard(tmp_path,'local:a');self.pace=no_wait
            async def foreground(self):await self.page.bring_to_front()
            async def check(self):self.guard.check()
            async def evaluate(self,source):return dict(loggedIn=True,handle='42',userId='u',followers=12)
            async def close(self):pass
        class Runtime:
            async def connect(self,profile,guard=False,open_creator=False):
                assert open_creator is True
                return Connection()
        old=dict(id='n',accountId='a',title='Owned',summary='body',images=['https://a.xhscdn.com/a'],mediaType='image',mediaAssets=[dict(id='b'*32,kind='image',index=0,sourceUrl='https://a.xhscdn.com/a')])
        input=dict(_jobId='c9014397-9dd5-4daa-8f84-4918408414fd',target=dict(id='a',handle='42',name='Account',profile='local:a'),knownNotes=[old],knownComments=[],knownMessages=[],mode='incremental',availableAssets=['n:'+'b'*32])
        patches=[]
        async def progress(p):patches.append(p)
        result=await SyncExecutor(tmp_path,Runtime())(input,progress)
        assert result['notes'][0]['images']==old['images']
        assert [c['id'] for c in result['comments']]==['fresh']
        assert result['media']['cached']==1 and not result['loginRequired']
        assert result['account']['followers']==12
        assert any(p.get('checkpoint') for p in patches)
        assert read_json(tmp_path/'sync-jobs'/input['_jobId']/'result.json')['comments'][0]['id']=='fresh'
    run(scenario())
