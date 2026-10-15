"""Python Playwright/CDP browser lifecycle and strict account evidence."""
from __future__ import annotations
import asyncio
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import httpx
from contextlib import asynccontextmanager
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urlsplit
from app.protocols import valid_id,valid_profile
from .cdp import browser_version,PassiveObserver,RawCDP
from .files import read_json,atomic_json
from .execution_browser import bundled_browser_roots,packaged_browser
from .safety import ExecutionGuard,ActionPacer,ResultUnknown,request_rejected
from . import expressions as dom

WARNING = re.compile(r'安全验证|请完成验证|访问过于频繁|账号已被限制|账号异常|异常登录|账号被封禁|操作频繁|滑动验证')
CREATOR='https://creator.xiaohongshu.com'
WEB='https://www.xiaohongshu.com'

def chrome_candidates(platform_name=None,env=None,home=None):
    platform_name=platform_name or sys.platform; env=os.environ if env is None else env; home=home or env.get('HOME') or env.get('USERPROFILE') or str(Path.home())
    candidates=[env.get('MATRIX_CHROME_PATH'),env.get('CHROME_BIN')]
    bases=[env.get(k) for k in ('LOCALAPPDATA','ProgramFiles','PROGRAMFILES','ProgramFiles(x86)','PROGRAMFILES(X86)') if env.get(k)]
    if platform_name=='win32':candidates.extend(str(Path(base)/'Google/Chrome/Application/chrome.exe') for base in bases)
    elif platform_name=='darwin':candidates.extend(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',str(Path(home)/'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')])
    else:candidates.extend(['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'])
    if platform_name=='win32':candidates.extend(str(Path(base)/'Microsoft/Edge/Application/msedge.exe') for base in bases)
    elif platform_name=='darwin':candidates.extend(['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',str(Path(home)/'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')])
    else:candidates.extend(['/usr/bin/microsoft-edge','/usr/bin/microsoft-edge-stable'])
    return list(dict.fromkeys(path for path in candidates if path))

async def until(read,accept,timeout=12,interval=.15):
    deadline=time.monotonic()+timeout; value=None
    while True:
        value=await read()
        if accept(value) or time.monotonic()>=deadline: return value
        await asyncio.sleep(interval)

def verify_session_identity(creator,web):
    if not creator.get('loggedIn'): return dict(loggedIn=False,creatorLoggedIn=False,webLoggedIn=False,stage='creator',creator=creator,web=None,message='等待扫码登录创作服务平台')
    if not web or not web.get('loggedIn'): return dict(loggedIn=False,creatorLoggedIn=True,webLoggedIn=False,stage='web',creator=creator,web=web,message='创作平台已登录，请在浏览器中继续扫码网页版')
    handle=str(creator.get('handle','')); web_handle=str(web.get('redId','')); confirmed=bool(handle and web_handle)
    mismatch=confirmed and (handle.lower()!=web_handle.lower() or creator.get('userId') and web.get('userId') and str(creator['userId'])!=str(web['userId']))
    return dict(loggedIn=bool(confirmed and not mismatch),creatorLoggedIn=True,webLoggedIn=True,stage='verifying' if not confirmed else 'mismatch' if mismatch else 'ready',creator=creator,web=web,creatorHandle=handle,webHandle=web_handle,handle=handle,name=creator.get('name') or web.get('name'),followers=creator.get('followers'),message='创作平台与网页版账号不一致' if mismatch else '')

def matches_native_topic_text(text,body,tags,persisted=False):
    if not tags or not text.startswith(body+'\n'): return False
    remaining=text[len(body):].strip()
    for tag in tags:
        label='#'+tag+('[话题]#' if persisted else '')
        if not remaining.startswith(label): return False
        remaining=remaining[len(label):].lstrip()
    return not remaining

def verify_persisted_draft(snapshot,task,file_ids,require_native_topics=False):
    if not snapshot or not snapshot.get('available') or snapshot.get('matches')!=1 or len(snapshot.get('records',[]))!=1: return None
    row=snapshot['records'][0]; tags=row.get('tags') or []
    normalized=[(t if isinstance(t,str) else t.get('name',t.get('topicName',''))).removeprefix('#') for t in tags]
    canonical=lambda s:re.sub(r'^\t+$','',str(s or '').replace('\r',''),flags=re.M)
    body=canonical(row.get('body')); approved=canonical(task['body']); suffix='\n'+' '.join('#'+t for t in task['tags']) if task['tags'] else ''
    structured=body==approved and normalized==task['tags']; inline=not normalized and body==approved+suffix
    native=matches_native_topic_text(body,approved,task['tags'],persisted=True) and normalized==task['tags'] and all(isinstance(t,dict) and t.get('id') and t.get('link') for t in tags)
    if require_native_topics and task['tags'] and not native: raise ValueError('草稿中的标签尚未关联小红书真实话题，不能确认同步成功')
    images=row.get('images')
    if row.get('title')!=task['title'] or not (structured or inline or native) or not isinstance(images,list) or len(images)!=len(task['images']) or any(not image.get('fileId') or image.get('status')!=2 for image in images): raise ValueError('已有同名草稿与审核稿不一致，已停止重复上传，请人工核对')
    if not isinstance(file_ids,list) or len(file_ids)!=len(images) or any(image['fileId']!=file_ids[i] for i,image in enumerate(images)): raise ValueError('已有草稿图片与本次上传回读不一致，已停止重复上传')
    return dict(title=row['title'],body=task['body'],tags=task['tags'],imageCount=len(images),draftId=row.get('draftId'))

def verify_editor(actual,task):
    topics=actual.get('topics')
    if topics is not None and task['tags'] and (len(topics)!=len(task['tags']) or any(not t.get('id') or not t.get('link') or t.get('name')!=task['tags'][i] for i,t in enumerate(topics))): raise ValueError('话题未全部关联平台话题，请选择真实候选后再保存')
    if not actual.get('editor'): raise ValueError('未找到标题或正文输入框')
    if actual.get('title')!=task['title']: raise ValueError('页面标题与审核稿不一致')
    canonical=lambda s:re.sub(r'\n{3,}','\n\n',re.sub(r'[ \t]+$','',s.replace('\u00a0',' ').replace('\r',''),flags=re.M)).strip()
    text=canonical(actual.get('text','')); body=canonical(task['body']); suffix='\n'+' '.join('#'+t for t in task['tags']) if task['tags'] else ''
    matches=matches_native_topic_text(text,body,task['tags']) if topics is not None and task['tags'] else text==canonical(task['body']+suffix)
    if not matches: raise ValueError('页面正文/标签与审核稿不一致，尚未确认草稿保存')
    if actual.get('imageCount')!=len(task['images']): raise ValueError('真实媒体预览数量不一致，保留页面，未重复上传')
    return dict(title=actual['title'],body=task['body'],tags=task['tags'],imageCount=actual['imageCount'])

def process_alive(pid):
    # Unknown ownership is not permission to launch another account window.
    if type(pid) is not int or pid<=0:return True
    if os.name=='nt':
        import ctypes
        from ctypes import wintypes
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]
        kernel.OpenProcess.restype=wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD]
        kernel.WaitForSingleObject.restype=wintypes.DWORD
        kernel.CloseHandle.argtypes=[wintypes.HANDLE]
        handle=kernel.OpenProcess(0x00100000,False,pid) # SYNCHRONIZE; no termination rights.
        if not handle:return ctypes.get_last_error()!=87 # invalid PID; other failures are uncertain.
        try:return kernel.WaitForSingleObject(handle,0)!=0
        finally:kernel.CloseHandle(handle)
    try:os.kill(pid,0);return True
    except ProcessLookupError:return False
    except PermissionError:return True

@asynccontextmanager
async def profile_lock(directory:Path,profile:str,task_id:str):
    directory.mkdir(parents=True,exist_ok=True); lock=directory/(hashlib.sha256(profile.encode()).hexdigest()+'.lock')
    try: lock.mkdir()
    except FileExistsError:
        owner=read_json(lock/'owner.json',{}); alive=process_alive(owner.get('pid'))
        if alive: raise ValueError('此 Chrome 正在同步另一项任务，请等当前同步结束后再试')
        # Remove only the known stale owner file, never an arbitrary directory tree.
        (lock/'owner.json').unlink(missing_ok=True); lock.rmdir(); lock.mkdir()
    owner=dict(pid=os.getpid(),taskId=task_id); atomic_json(lock/'owner.json',owner)
    try: yield
    finally:
        if read_json(lock/'owner.json')==owner: (lock/'owner.json').unlink(missing_ok=True); lock.rmdir()

class BrowserConnection:
    def __init__(self,browser,context,page,guard=None,pace=None):
        self.browser=browser; self.context=context; self.page=page; self.guard=guard; self.pace=pace or ActionPacer(); self.halted=None; self.sessions={}; self.closed=False
        context.on('response',self.on_response)
    def on_response(self,response):
        u=urlsplit(response.url)
        if self.guard and (u.hostname=='xiaohongshu.com' or (u.hostname or '').endswith('.xiaohongshu.com')) and request_rejected(response.status):
            self.halted=f'平台拒绝本次请求（HTTP {response.status}），已暂停后续操作，请人工核对'; self.guard.halt(self.halted,response.headers.get('retry-after'))
    async def check(self):
        if not self.guard: return
        self.guard.check()
        if self.halted: raise ValueError(self.halted)
        warning=await self.page.evaluate('document.body?.innerText?.slice(0,30000)||""')
        if WARNING.search(warning): self.guard.halt('平台要求验证或限制了操作，请在原电脑人工核对'); raise ValueError('平台要求验证或限制了操作，请在原电脑人工核对')
        self.guard.check()
    async def evaluate(self,source):
        await self.check()
        try: return await asyncio.wait_for(self.page.evaluate(source),15)
        except asyncio.TimeoutError as exc: raise ResultUnknown('浏览器表达式超时，执行结果未知') from exc
    async def cdp(self,method,params=None):
        await self.check()
        if self.page not in self.sessions: self.sessions[self.page]=await self.context.new_cdp_session(self.page)
        try: return await asyncio.wait_for(self.sessions[self.page].send(method,params or {}),15)
        except asyncio.TimeoutError as exc: raise ResultUnknown(method+' 超时，执行结果未知') from exc
    async def foreground(self): await self.page.bring_to_front()
    async def wait_until_window_closed(self):
        # Monitor the actual account pages, even while the collector is waiting
        # for network responses or a pacing timer rather than touching the DOM.
        watched=[p for p in self.context.pages if p.url.startswith(CREATOR+'/') or re.match(r'https://(?:www\.)?xiaohongshu\.com/',p.url)]
        while not self.closed:
            if not self.browser.is_connected() or any(p.is_closed() for p in watched):
                raise ValueError('同步失败：小红书窗口已关闭，请点击开始同步重试；已保存的内容保留。')
            await asyncio.sleep(.2)
        await asyncio.Future()  # Normal collector cleanup is not a user closure.
    async def select(self,page): self.page=page; await self.cdp('Network.enable')
    async def new_page(self,url):
        await self.check(); await self.pace()
        page=await self.context.new_page(); await self.select(page); await page.goto(url,wait_until='domcontentloaded'); return page
    async def navigate(self,url):
        await self.check(); await self.pace(); await self.foreground(); await self.page.goto(url,wait_until='domcontentloaded')
    async def insert_text(self,text): await self.cdp('Input.insertText',dict(text=text))
    async def native_click(self,x,y):
        for type in ('mouseMoved','mousePressed','mouseReleased'):
            args=dict(type=type,x=x,y=y)
            if type!='mouseMoved': args.update(button='left',clickCount=1)
            await self.cdp('Input.dispatchMouseEvent',args)
    async def close(self):
        if self.closed: return
        self.closed=True; self.context.remove_listener('response',self.on_response)
        for session in self.sessions.values():
            try: await session.detach()
            except Exception: pass
        await self.browser.close()

class BrowserRuntime:
    def __init__(self,root:Path,*,playwright_factory=None,pace_factory=ActionPacer,browser_launcher=None):
        self.root=Path(root); self.playwright=None; self.playwright_factory=playwright_factory; self.pace_factory=pace_factory; self.launched={}; self.locks={}; self.browser_launcher=browser_launcher or self.launch_native_browser
    @staticmethod
    def launch_native_browser(executable,directory):
        # This starts native Chrome only. No shell or JavaScript backend bridge.
        args=[executable,'--user-data-dir='+str(directory),'--remote-debugging-port=0','--no-first-run','--no-default-browser-check',CREATOR+'/new/home']
        kwargs=dict(stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)
        if os.name=='nt':kwargs['creationflags']=subprocess.DETACHED_PROCESS|subprocess.CREATE_NEW_PROCESS_GROUP
        else:kwargs['start_new_session']=True
        return subprocess.Popen(args,**kwargs)
    def load(self,id):
        if not valid_id(id): raise ValueError('无效会话编号')
        session=read_json(self.root/id/'session.json')
        if session and (session.get('id')!=id or session.get('profile')!='local:'+id): raise ValueError('浏览器会话归属无效')
        return session
    async def engine(self):
        if self.playwright is None:
            if self.playwright_factory: self.playwright=await self.playwright_factory()
            else:
                from playwright.async_api import async_playwright
                self.playwright=await async_playwright().start()
        return self.playwright
    async def live(self,session):
        if not session: return False
        try: await browser_version(session); return True
        except Exception: return False
    async def connect(self,profile,*,guard=False,open_creator=False):
        if not valid_profile(profile): raise ValueError('只支持本机独立账号')
        session=self.load(profile[6:])
        if not session: raise ValueError('请先打开此账号专属浏览器并扫码登录')
        if guard:ExecutionGuard(self.root,profile).check()
        if session.get('starting'):session=await self.ensure(profile[6:])
        reopened=False
        try:version=await browser_version(session)
        except httpx.ConnectError:
            session=await self.ensure(profile[6:])
            version=await browser_version(session)
            reopened=True
        engine=await self.engine()
        browser=await engine.chromium.connect_over_cdp(version['webSocketDebuggerUrl'],timeout=30000)
        if not browser.contexts: await browser.close(); raise ValueError('专属浏览器没有可用上下文')
        context=browser.contexts[0]; context.set_default_timeout(8000); context.set_default_navigation_timeout(15000)
        page=next((p for p in context.pages if p.url.startswith(CREATOR+'/new/')),None) or next((p for p in context.pages if p.url.startswith(CREATOR+'/')),None)
        if page is None and (open_creator or reopened):
            ExecutionGuard(self.root,profile).check(); page=await context.new_page(); await page.goto(CREATOR+'/new/home',wait_until='domcontentloaded')
        if page is None: await browser.close(); raise ValueError('专属浏览器没有创作平台页面')
        if (reopened or open_creator) and not any(re.match(r'https://(?:www\.)?xiaohongshu\.com/',p.url) for p in context.pages):
            web=await context.new_page(); await web.goto(WEB+'/explore',wait_until='domcontentloaded')
        return BrowserConnection(browser,context,page,ExecutionGuard(self.root,profile) if guard else None,self.pace_factory())
    def executable(self):
        for path in chrome_candidates():
            if path and Path(path).is_file(): return path
        for root in bundled_browser_roots():
            if path:=packaged_browser(root):return path
        raise ValueError('未找到执行浏览器，请安装包含执行浏览器的完整客户端，或安装 Chrome/Edge 后重试；登录时不会自动下载')
    async def ensure(self,id):
        if not valid_id(id): raise ValueError('无效会话编号')
        async with self.locks.setdefault(id,asyncio.Lock()):
            # Also serialize separate runtime instances/processes sharing this profile.
            async with profile_lock(self.root/'browser-launch-locks','local:'+id,'browser-start'):
                session=self.load(id)
                if await self.live(session): return session
                directory=self.root/id/'chrome-profile'
                active=directory/'DevToolsActivePort'
                if session and process_alive(session.get('pid')):
                    # A slow first launch may have become ready after its timeout.
                    # Recover only its recorded endpoint; never start a second process.
                    if session.get('starting') and active.is_file():
                        lines=active.read_text().strip().splitlines()
                        if len(lines)>=2:
                            port=int(lines[0]);recovered={**session,'debugPort':port,'browserUrl':f'ws://127.0.0.1:{port}{lines[1]}','starting':False}
                            await browser_version(recovered);atomic_json(self.root/id/'session.json',recovered);return recovered
                    raise ValueError('此账号已有浏览器仍在运行，但连接暂不可用；请检查原窗口后重试，不会另开浏览器或要求重新扫码')
                if not session and active.exists():raise ValueError('此账号存在原浏览器记录，无法确认窗口已关闭；请检查原窗口，不会另开浏览器')
                directory.mkdir(parents=True,exist_ok=True,mode=0o700)
                active.unlink(missing_ok=True)
                process=self.browser_launcher(self.executable(),directory); self.launched[id]=process
                session=dict(id=id,pid=process.pid,profile='local:'+id,createdAt=datetime.now(timezone.utc).isoformat(),starting=True)
                atomic_json(self.root/id/'session.json',session)
                async def read_active():
                    try: return active.read_text().strip().splitlines()
                    except FileNotFoundError: return None
                lines=await until(read_active,lambda v:v and len(v)>=2,15)
                if not lines: raise ValueError('浏览器尚未就绪，请检查此账号已打开的窗口；不会重复启动或清除登录')
                port=int(lines[0]); session.update(debugPort=port,browserUrl=f'ws://127.0.0.1:{port}{lines[1]}',starting=False)
                await browser_version(session); atomic_json(self.root/id/'session.json',session); return session
    async def state(self,id):
        session=self.load(id)
        if not await self.live(session): return dict(connected=False,loggedIn=False,creatorLoggedIn=False,webLoggedIn=False,message='请点击打开小红书，并在执行电脑完成登录')
        try:connection=await self.connect('local:'+id)
        except ValueError as error:
            if str(error)!='专属浏览器没有创作平台页面':raise
            return dict(connected=True,loggedIn=False,creatorLoggedIn=False,webLoggedIn=False,message='账号窗口缺少创作平台页面，请点击同步恢复原窗口')
        try:
            creator=await connection.evaluate(dom.expression(dom.READCREATORIDENTITY))
            web_pages=[p for p in connection.context.pages if re.match(r'https://(?:www\.)?xiaohongshu\.com/',p.url)]
            web_page=next((p for p in web_pages if not p.url.startswith(WEB+'/login')),None) or next(iter(web_pages),None)
            web=None
            if creator.get('loggedIn') and web_page:
                await connection.select(web_page); web=await connection.evaluate(dom.expression(dom.READWEBIDENTITY))
            return {**verify_session_identity(creator,web),'connected':True,'profile':session['profile']}
        finally: await connection.close()
    async def login(self,id):
        await self.ensure(id); connection=await self.connect('local:'+id,guard=True,open_creator=True)
        try:
            await connection.foreground()
            async def prepare():
                state=await connection.evaluate(r"""(()=>({qr:[...document.querySelectorAll('img.css-1lhmg90,img[src*="qr" i],canvas,[class*="qr" i]')].some(e=>{const r=e.getBoundingClientRect();return r.width>100&&r.height>100&&r.bottom>0&&r.right>0}),toggle:!!document.querySelector('img.css-wemwzq,img[class*="wemwzq" i]')}))()""")
                identity=await connection.evaluate(dom.expression(dom.READIDENTITY))
                if state['toggle'] and not state['qr'] and not identity.get('loggedIn'): await connection.evaluate("document.querySelector('img.css-wemwzq,img[class*=\"wemwzq\" i]')?.click()")
                return state['qr'] or identity.get('loggedIn')
            if not await until(prepare,bool,25,.2): raise ValueError('创作平台二维码未就绪，请检查可见 Chrome 登录窗口')
            if not any(re.match(r'https://(?:www\.)?xiaohongshu\.com/',p.url) for p in connection.context.pages): await connection.new_page(WEB+'/login')
            return dict(accountId=id,profile='local:'+id,message='专属浏览器登录窗口已打开，请在浏览器中使用小红书 App 扫码')
        finally: await connection.close()
    async def qr(self,id):
        info=await self.state(id); connection=await self.connect('local:'+id)
        try:
            if info.get('stage')=='web':
                web=next((p for p in connection.context.pages if re.match(r'https://(?:www\.)?xiaohongshu\.com/',p.url)),None)
                if web is None: raise ValueError('请重新点击打开小红书登录')
                await connection.select(web)
            clip=await connection.evaluate(r"""(()=>{for(const selector of ['img.css-1lhmg90','img[src*="qr" i]','canvas','[class*="qr" i]'])for(const e of document.querySelectorAll(selector)){const r=e.getBoundingClientRect();if(r.width>100&&r.height>100&&r.bottom>0&&r.right>0)return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1};}return null;})()""")
            if not clip: raise ValueError('当前页面没有可用二维码')
            return await connection.cdp('Page.captureScreenshot',dict(format='png',clip=clip))
        finally: await connection.close()
    async def observe(self,profile):
        if not valid_profile(profile): return None
        session=self.load(profile[6:])
        return await PassiveObserver.open(session) if session else None
    async def remove(self,id):
        session=self.load(id)
        if session:
            try:version=await browser_version(session)
            except Exception:version=None
            if version:
                raw=await RawCDP.open(version['webSocketDebuggerUrl'])
                try:await raw.send('Browser.close')
                except ResultUnknown:pass # Chrome closes its transport with the window.
                finally:await raw.close()
            atomic_json(self.root/id/'session.json',{**session,'removedAt':time.time()*1000})
        self.launched.pop(id,None)
    async def close(self):
        # Browser account profiles remain untouched. Attached automation is disconnected.
        if self.playwright: await self.playwright.stop(); self.playwright=None
